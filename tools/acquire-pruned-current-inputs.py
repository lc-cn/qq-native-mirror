"""Download two pinned CI sources; never execute extracted code or overwrite input files."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import zipfile

repo = 'lc-cn/qq-native-mirror'
sdk_commit = '5907793ad848c68b3183ac5c2f2b06fbd1a5e0cf'
sdk_run = '38000680198'
native_commit = '6cae1ec0a5e1bfb03cb7871083915b3d03272347'
pins = {
    'arm64': ('37971314866', '47667990e7c237f7d628338f96c1f531fc47df64',
              'db2ca1c4a19f62033906e8c16a45558540d98080b1987083ffbee12c34137e12',
              '3128a4741044520f7c99a89673db0d04f3183312d7ff0191d580ddb2ca816da8'),
    'x64': ('37974055180', '5797fe9463d077c8c41d466480f04b9868fc647a',
            '9aaf7449c7e13611d5c6c02e12ea2941a28dd1dd7f60bd72edaec9be0eb3c766',
            '27a1b4ba476d353d538d01d3e6c5b934c91621c9bbffe75f23445a8a01ce742f'),
}

def sha(body):
    return hashlib.sha256(body).hexdigest()

def gh(path):
    return subprocess.check_output(['gh', 'api', path], timeout=300)

def acquire(run_id, commit, artifact_name, wanted):
    run_bytes = gh(f'repos/{repo}/actions/runs/{run_id}')
    run = json.loads(run_bytes)
    assert run['status'] == 'completed' and run['conclusion'] == 'success'
    assert run['head_sha'] == commit and run['run_attempt'] == 1
    rows = json.loads(gh(f'repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100'))['artifacts']
    matches = [row for row in rows if row['name'] == artifact_name]
    assert len(matches) == 1 and not matches[0]['expired']
    row = matches[0]
    assert 0 < row['size_in_bytes'] <= 256 * 1024 * 1024
    body = gh(f"repos/{repo}/actions/artifacts/{row['id']}/zip")
    assert len(body) == row['size_in_bytes'] and 'sha256:' + sha(body) == row['digest']
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names))
        assert all(not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts
                   and '\\' not in name for name in names)
        assert sum(item.file_size for item in archive.infolist()) < 768 * 1024 * 1024
        result = {}
        for name in wanted:
            assert name in names and not archive.getinfo(name).is_dir()
            result[name] = archive.read(name)
    metadata = {'run': run, 'artifact': row, 'zipSha256': sha(body),
                'selectedFiles': {name: {'size': len(data), 'sha256': sha(data)}
                                  for name, data in result.items()}}
    return result, metadata

if __name__ == '__main__':
    assert len(sys.argv) == 3 and sys.argv[1] in pins
    arch, output = sys.argv[1], Path(sys.argv[2])
    output.mkdir()  # New output only, including after uncertain failure.
    prune_run, prune_commit, main_sha, aux_sha = pins[arch]
    main_name = 'qq-native-client-0.0.2.tgz'
    aux_name = f'qq-native-client-darwin-{arch}-0.0.2.tgz'
    main, sdk_meta = acquire(sdk_run, sdk_commit,
        f'experimental-full-object-storage-darwin-{arch}', [main_name, 'consumer-sdk.json'])
    pruned, prune_meta = acquire(prune_run, prune_commit,
        f'experimental-darwin-{arch}-resources-codec-v2',
        [aux_name, 'pruning-profile.json', 'pruning-build.json', 'source-release-manifest.json'])
    assert sha(main[main_name]) == main_sha and sha(pruned[aux_name]) == aux_sha
    sdk = json.loads(main['consumer-sdk.json'])
    assert sdk['builderCommit'] == sdk_commit and sdk['builderRunId'] == sdk_run
    assert sdk['tarball'] == main_name and sdk['sha256'] == main_sha and sdk['size'] == len(main[main_name])
    profile = json.loads(pruned['pruning-profile.json'])
    assert profile['arch'] == arch and profile['source']['commit'] == native_commit
    assert profile['source']['runId'] == '37962268125'
    assert sha(pruned['source-release-manifest.json']) == profile['source']['releaseManifestSha256']
    for name, body in {**main, **pruned}.items():
        with (output / name).open('xb') as handle:
            handle.write(body)
    binding = {'sdkCommit': sdk_commit, 'sdkRun': sdk_run, 'nativeCommit': native_commit,
               'nativeRun': '37962268125', 'prunedRun': prune_run, 'arch': arch,
               'mainSha256': main_sha, 'auxiliarySha256': aux_sha,
               'sources': {'sdk': sdk_meta, 'pruned': prune_meta},
               'accountOperationsAuthorized': False, 'published': False, 'defaultsChanged': False}
    (output / 'input-binding.json').write_text(json.dumps(binding, indent=2) + '\n')
    print(json.dumps({'arch': arch, 'mainSha256': main_sha, 'auxiliarySha256': aux_sha,
                      'accountUsed': False, 'nativeExecuted': False}))
