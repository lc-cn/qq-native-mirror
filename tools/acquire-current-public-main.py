"""Acquire a pinned successful CI aggregate; offline validation only, never publish."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tempfile
import threading
import zipfile

REPOSITORY = 'lc-cn/qq-native-mirror'
REPOSITORY_ID = 1410183127
RUN_ID = 38005239931
COMMIT = '7ec1a309da4137c5eef190482c731889f6341392'
WORKFLOW = '.github/workflows/native-npm.yml'
ARTIFACT_ID = 11650703913
ZIP_SIZE = 388134440
ZIP_SHA = '0bfdfe0cf747f9c33fa777749605b9451da1d5c4cd9712caff647f3cd550d7cc'
MAIN = {'name': 'qq-native-client', 'version': '0.0.2', 'tarball': 'qq-native-client-0.0.2.tgz',
        'size': 452930, 'sha256': '685803fcaf965cdf827fffb2d79c08885182a3a718dc59b27670af07672f6988',
        'integrity': 'sha512-PL4aqvSLKruciMCeleD02hi5Bqps92+Va5C7Esk8nSzSYxj3otqZZa6W/SRuYRAqQ53HqGy+HKpUrPml2O+1NQ=='}
DEVICES = ('linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64')
EXPECTED = {MAIN['tarball'], 'release-manifest.json', 'video-materials/video-materials-binding.json',
            'video-materials/video-materials.json', 'evidence/aggregated-main.consumer.json'} | {
    f'qq-native-client-{d}-0.0.2.tgz' for d in DEVICES} | {f'evidence/{d}.consumer.json' for d in DEVICES}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def validate_metadata(run, artifact):
    require(run.get('id') == RUN_ID and run.get('path') == WORKFLOW and
            run.get('head_sha') == COMMIT and run.get('run_attempt') == 1 and
            run.get('status') == 'completed' and run.get('conclusion') == 'success' and
            run.get('repository', {}).get('full_name') == REPOSITORY and
            run.get('repository', {}).get('id') == REPOSITORY_ID, 'Pinned successful source run mismatch')
    require(artifact.get('id') == ARTIFACT_ID and artifact.get('name') == 'npm-release' and
            artifact.get('expired') is False and artifact.get('size_in_bytes') == ZIP_SIZE and
            artifact.get('digest') == 'sha256:' + ZIP_SHA, 'Pinned source artifact mismatch')
    workflow = artifact.get('workflow_run', {})
    require(workflow.get('id') == RUN_ID and workflow.get('head_sha') == COMMIT and
            workflow.get('repository_id') == REPOSITORY_ID and
            workflow.get('head_repository_id') == REPOSITORY_ID, 'Artifact workflow source mismatch')


def verify_archive(path, expected_sha=ZIP_SHA, expected_size=ZIP_SIZE):
    require(Path(path).stat().st_size == expected_size and expected_size <= 512 * 1024 * 1024,
            'Source ZIP size mismatch')
    require(sha_file(path) == expected_sha, 'Source ZIP SHA mismatch')


def extract_aggregate(path, directory):
    """Two-pass inventory then stream only a closed set of regular entries."""
    directory = Path(directory)
    with zipfile.ZipFile(path) as archive:
        rows = archive.infolist()
        require(len(rows) <= 64 and len({r.filename for r in rows}) == len(rows), 'Duplicate/excess ZIP members')
        files = set()
        total = 0
        for row in rows:
            name = row.filename
            pure = PurePosixPath(name)
            require(name and not pure.is_absolute() and ':' not in name and '\\' not in name and '\x00' not in name and
                    not any(ord(c) < 32 for c in name) and '..' not in pure.parts and
                    name.rstrip('/') == str(pure), 'Unsafe ZIP path')
            mode = stat.S_IFMT(row.external_attr >> 16)
            require(mode in (0, stat.S_IFREG, stat.S_IFDIR), 'Nonregular ZIP entry')
            if row.is_dir():
                require(name in ('evidence/', 'video-materials/') and row.file_size == 0 and
                        mode in (0, stat.S_IFDIR), 'Unexpected ZIP directory')
                continue
            require(mode != stat.S_IFDIR and name in EXPECTED and not (row.flag_bits & 1), 'Unexpected/encrypted ZIP file')
            total += row.file_size
            require(row.file_size <= 512 * 1024 * 1024 and total <= 512 * 1024 * 1024, 'Expanded ZIP size limit')
            files.add(name)
        require(files == EXPECTED, 'Incomplete aggregate ZIP inventory')
        for row in rows:
            if row.is_dir():
                continue
            target = directory / row.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            count = 0
            with archive.open(row) as source, target.open('xb') as output:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    count += len(chunk)
                    require(count <= row.file_size, 'Expanded member overflow')
                    output.write(chunk)
            require(count == row.file_size, 'Truncated ZIP member')


def gh_json(path):
    body = subprocess.check_output(['gh', 'api', f'repos/{REPOSITORY}/{path}'], timeout=120)
    require(len(body) <= 4 * 1024 * 1024, 'API metadata limit')
    return json.loads(body)


def download_archive(archive):
    process = subprocess.Popen(['gh', 'api', f'repos/{REPOSITORY}/actions/artifacts/{ARTIFACT_ID}/zip'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    timer = threading.Timer(1200, process.kill)
    timer.start()
    try:
        total = 0
        with Path(archive).open('xb') as output:
            for chunk in iter(lambda: process.stdout.read(1024 * 1024), b''):
                total += len(chunk)
                require(total <= ZIP_SIZE, 'Downloaded ZIP exceeds pinned size')
                output.write(chunk)
        require(process.wait(timeout=5) == 0 and total == ZIP_SIZE, 'ZIP transport failed/truncated')
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()


def acquire(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    run = gh_json(f'actions/runs/{RUN_ID}')
    artifact = gh_json(f'actions/artifacts/{ARTIFACT_ID}')
    validate_metadata(run, artifact)
    with tempfile.TemporaryDirectory(prefix='qq-current-main-') as scratch:
        archive = Path(scratch) / 'source.zip'
        download_archive(archive)
        verify_archive(archive)
        extract_aggregate(archive, directory)
    # Recheck source identity after transfer; never continue from mixed state.
    validate_metadata(gh_json(f'actions/runs/{RUN_ID}'), gh_json(f'actions/artifacts/{ARTIFACT_ID}'))
    manifest_bytes = (directory / 'release-manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    require(manifest.get('schemaVersion') == 2 and manifest.get('repository') == REPOSITORY and
            manifest.get('runId') == str(RUN_ID) and manifest.get('runAttempt') == 1 and
            manifest.get('commit') == COMMIT, 'Aggregate source identity mismatch')
    require([p for p in manifest.get('packages', []) if p.get('name') == MAIN['name']] == [MAIN],
            'Actual main package pin mismatch')
    require((directory / MAIN['tarball']).stat().st_size == MAIN['size'] and
            sha_file(directory / MAIN['tarball']) == MAIN['sha256'], 'Actual main bytes mismatch')
    validator = Path(__file__).resolve().parent.parent / 'sdk/scripts/local-first-publish.mjs'
    # The actual CLI accepts DIRECTORY only for offline dry-run. No publish flag.
    subprocess.run(['node', str(validator), str(directory.resolve())], check=True, timeout=600)
    binding = {'schemaVersion': 1, 'repository': REPOSITORY, 'commit': COMMIT, 'runId': str(RUN_ID),
               'runAttempt': 1, 'workflowPath': WORKFLOW,
               'artifact': {'id': ARTIFACT_ID, 'name': 'npm-release', 'size': ZIP_SIZE, 'sha256': ZIP_SHA},
               'releaseManifestSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'main': MAIN,
               'offlineValidated': True, 'nativeExecuted': False, 'accountUsed': False, 'published': False}
    with (directory / 'acquisition-binding.json').open('x') as handle:
        json.dump(binding, handle, indent=2)
        handle.write('\n')
    print(json.dumps({'acquired': True, 'runId': str(RUN_ID), 'mainSha256': MAIN['sha256'],
                      'nativeExecuted': False, 'published': False}))


if __name__ == '__main__':
    try:
        require(len(sys.argv) <= 2, 'Use OUTPUT_DIRECTORY only')
        acquire(sys.argv[1] if len(sys.argv) == 2 else 'out/current-main-source')
    except Exception:
        print('Pinned current main acquisition failed; no publication performed', file=sys.stderr)
        sys.exit(1)
