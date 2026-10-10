import copy
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('acquirer', Path(__file__).with_name('acquire-current-public-main.py'))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


def metadata():
    run = {'id': a.RUN_ID, 'path': a.WORKFLOW, 'head_sha': a.COMMIT, 'run_attempt': 1,
           'status': 'completed', 'conclusion': 'success',
           'repository': {'full_name': a.REPOSITORY, 'id': a.REPOSITORY_ID}}
    artifact = {'id': a.ARTIFACT_ID, 'name': 'npm-release', 'expired': False,
                'size_in_bytes': a.ZIP_SIZE, 'digest': 'sha256:' + a.ZIP_SHA,
                'workflow_run': {'id': a.RUN_ID, 'head_sha': a.COMMIT,
                                 'repository_id': a.REPOSITORY_ID, 'head_repository_id': a.REPOSITORY_ID}}
    return run, artifact


def fixture_zip(extra=None, omit=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as z:
        for name in sorted(a.EXPECTED):
            if name != omit:
                z.writestr(name, b'owned fixture bytes')
        if extra:
            extra(z)
    return output.getvalue()


class Contracts(unittest.TestCase):
    def test_exact_metadata_and_each_identity_refusal(self):
        run, artifact = metadata()
        a.validate_metadata(run, artifact)
        for field, value in [('id', 1), ('head_sha', '0'*40), ('path', '.github/workflows/other.yml'),
                             ('run_attempt', 2), ('conclusion', 'failure'), ('status', 'in_progress')]:
            bad = copy.deepcopy(run); bad[field] = value
            with self.assertRaises(ValueError): a.validate_metadata(bad, artifact)
        for field, value in [('id', 1), ('name', 'other'), ('expired', True), ('size_in_bytes', 1), ('digest', 'sha256:'+'0'*64)]:
            bad = copy.deepcopy(artifact); bad[field] = value
            with self.assertRaises(ValueError): a.validate_metadata(run, bad)
        for field, value in [('id', 1), ('head_sha', '0'*40), ('repository_id', 1), ('head_repository_id', 1)]:
            bad = copy.deepcopy(artifact); bad['workflow_run'][field] = value
            with self.assertRaises(ValueError): a.validate_metadata(run, bad)

    def test_hash_size_and_closed_regular_extraction(self):
        body = fixture_zip()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'archive.zip'; path.write_bytes(body)
            a.verify_archive(path, hashlib.sha256(body).hexdigest(), len(body))
            with self.assertRaises(ValueError): a.verify_archive(path, '0'*64, len(body))
            with self.assertRaises(ValueError): a.verify_archive(path, hashlib.sha256(body).hexdigest(), len(body)+1)
            out = Path(tmp)/'out'; out.mkdir(); a.extract_aggregate(path, out)
            self.assertEqual({p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file()}, a.EXPECTED)

    def test_unsafe_duplicate_symlink_and_missing_members_rejected_before_writes(self):
        def link(z):
            row = zipfile.ZipInfo('evil'); row.create_system = 3; row.external_attr = 0o120777 << 16
            z.writestr(row, '../outside')
        variants = [lambda z:z.writestr('../evil', 'x'),lambda z:z.writestr('evidence//evil','x'),
                    lambda z:z.writestr('evidence/../evil','x'),lambda z:z.writestr('C:\\evil','x'),
                    lambda z:z.writestr(next(iter(a.EXPECTED)), 'duplicate'),link]
        bodies = [fixture_zip(extra=f) for f in variants] + [fixture_zip(omit='release-manifest.json')]
        for body in bodies:
            with tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp)/'archive.zip';path.write_bytes(body);out=Path(tmp)/'out';out.mkdir()
                with self.assertRaises(ValueError):a.extract_aggregate(path,out)
                self.assertEqual(list(out.iterdir()), [])

    def test_streaming_bound_kills_child_before_extraction(self):
        from unittest.mock import patch
        class Process:
            def __init__(self, body): self.stdout=io.BytesIO(body);self.done=False;self.killed=False;self.waited=False
            def poll(self):return 0 if self.done else None
            def kill(self):self.killed=True;self.done=True
            def wait(self,timeout=None):self.waited=True;self.done=True;return 0
        with tempfile.TemporaryDirectory() as tmp:
            child=Process(b'x'*17)
            with patch.object(a,'ZIP_SIZE',16),patch.object(a.subprocess,'Popen',return_value=child):
                with self.assertRaisesRegex(ValueError,'exceeds pinned size'):a.download_archive(Path(tmp)/'oversize.zip')
            self.assertTrue(child.killed);self.assertTrue(child.waited);self.assertEqual((Path(tmp)/'oversize.zip').stat().st_size,0)
            good=Process(b'x'*16)
            with patch.object(a,'ZIP_SIZE',16),patch.object(a.subprocess,'Popen',return_value=good):a.download_archive(Path(tmp)/'good.zip')
            self.assertTrue(good.waited);self.assertFalse(good.killed);self.assertEqual((Path(tmp)/'good.zip').read_bytes(),b'x'*16)

    def test_expanded_size_limit(self):
        class Row:
            filename = next(iter(a.EXPECTED)); external_attr = 0; flag_bits = 0; file_size = 513*1024*1024
            def is_dir(self):return False
        class FakeZip:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def infolist(self):return [Row()]
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp,patch.object(a.zipfile,'ZipFile',return_value=FakeZip()):
            with self.assertRaisesRegex(ValueError,'Expanded ZIP size'):a.extract_aggregate('unused',tmp)


if __name__ == '__main__':
    unittest.main()
