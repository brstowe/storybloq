"""prepare.py: pinned native-addon prebuilds for packages whose install script never runs."""
import hashlib
import io
import tarfile
from pathlib import Path

import pytest

from manifest import prepare


def fake_tgz(member: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        info = tarfile.TarInfo(member)
        info.size = 4
        tf.addfile(info, io.BytesIO(b"\x7fELF"))
    return buf.getvalue()


@pytest.fixture
def fetch(monkeypatch):
    urls: list[str] = []

    def fake_retrieve(url, dest):
        urls.append(url)
        Path(dest).write_bytes(fake_tgz("build/Release/better_sqlite3.node"))

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlretrieve", fake_retrieve)
    return urls


def test_nested_copy_and_two_versions_each_get_their_own_pin(tmp_path, fetch):
    lock = {"packages": {
        "node_modules/better-sqlite3": {"version": "12.11.1", "hasInstallScript": True},
        "node_modules/some-dep/node_modules/better-sqlite3": {"version": "11.0.0", "hasInstallScript": True},
        "node_modules/plain": {"version": "1.0.0"},
    }}
    pins = prepare.pin_prebuilds(tmp_path, lock, "22.23.2")
    assert [(p["path"], p["version"], p["abi"]) for p in pins] == [
        ("node_modules/better-sqlite3", "12.11.1", "127"), ("node_modules/some-dep/node_modules/better-sqlite3", "11.0.0", "127")]
    assert len({p["file"] for p in pins}) == 2 and all(p["member"] == "build/Release/better_sqlite3.node" for p in pins)
    for p in pins:
        assert hashlib.sha256((tmp_path / p["file"]).read_bytes()).hexdigest() == p["sha256"]
    assert fetch == [p["url"] for p in pins] and all(u.endswith("-node-v127-linux-x64.tar.gz") for u in fetch)


def test_install_script_without_recipe_refuses(tmp_path, fetch):
    lock = {"packages": {"node_modules/sharp": {"version": "0.33.0", "hasInstallScript": True}}}
    with pytest.raises(SystemExit, match="no pinned prebuild recipe"):
        prepare.pin_prebuilds(tmp_path, lock, "22.23.2")


def test_lock_key_escaping_the_project_refuses(tmp_path, fetch):
    lock = {"packages": {"node_modules/../better-sqlite3": {"version": "12.11.1", "hasInstallScript": True}}}
    with pytest.raises(SystemExit, match="not an in-project node_modules path"):
        prepare.pin_prebuilds(tmp_path, lock, "22.23.2")


def test_unknown_node_abi_refuses(tmp_path, fetch):
    with pytest.raises(SystemExit, match="ABI"):
        prepare.pin_prebuilds(tmp_path, {"packages": {"node_modules/better-sqlite3": {"version": "1", "hasInstallScript": True}}}, "99.0.0")


def test_tarball_lacking_member_refuses(tmp_path, monkeypatch):
    import urllib.request

    monkeypatch.setattr(urllib.request, "urlretrieve", lambda url, dest: Path(dest).write_bytes(fake_tgz("README")))
    with pytest.raises(SystemExit, match="lacks build/Release/better_sqlite3.node"):
        prepare.pin_prebuilds(tmp_path, {"packages": {"node_modules/better-sqlite3": {"version": "12.11.1", "hasInstallScript": True}}}, "22.23.2")
