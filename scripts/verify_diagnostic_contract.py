"""Verify approved manifest and exact worktree/index bytes; never rewrite them."""
import hashlib
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / 'contracts/diagnostics/v1'
DIGEST = 'ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4'


def main():
    manifest = (CONTRACT/'SHA256SUMS').read_bytes()
    assert hashlib.sha256(manifest).hexdigest() == DIGEST
    names = ['SHA256SUMS']
    for line in manifest.decode('utf8').splitlines():
        digest, name = line.split('  ',1)
        assert hashlib.sha256((CONTRACT/name).read_bytes()).hexdigest() == digest, name
        names.append(name)
    for name in names:
        relative = 'contracts/diagnostics/v1/'+name
        indexed = subprocess.run(['git','show',':'+relative],cwd=ROOT,check=True,capture_output=True).stdout
        assert indexed == (ROOT/relative).read_bytes(), relative
        assert b'\r' not in indexed and not indexed.startswith(b'\xef\xbb\xbf'), relative
    print(f'PASS: {len(names)} contract files; worktree == index; manifest {DIGEST}')


if __name__ == '__main__': main()
