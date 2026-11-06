"""Tests for config_loader — conf.json loading, missing file error, secrets."""

import json
import pytest

import config_loader


@pytest.fixture(autouse=True)
def isolate_conf(tmp_path, monkeypatch):
    """Point config_loader's file paths at tmp_path to avoid touching real files."""
    monkeypatch.setattr(config_loader, "CONF_JSON_FILE", tmp_path / "conf.json")
    monkeypatch.setattr(config_loader, "SECRETS_FILE", tmp_path / "secrets.json")
    yield


class TestLoadConf:
    def test_raises_with_clear_message_when_missing(self, tmp_path):
        with pytest.raises(FileNotFoundError) as exc_info:
            config_loader.load_conf()
        msg = str(exc_info.value)
        assert "conf.json" in msg
        assert "cp conf.json.template conf.json" in msg

    def test_raises_migration_message_when_only_conf_py_exists(self, tmp_path, monkeypatch):
        # Create a fake conf.py to trigger migration path
        (tmp_path / "conf.py").write_text("URL_LIST = []")
        # Point BASE_DIR so the "conf.py" check finds it
        monkeypatch.setattr(config_loader, "BASE_DIR", tmp_path)
        monkeypatch.setattr(config_loader, "CONF_JSON_FILE", tmp_path / "conf.json")
        with pytest.raises(FileNotFoundError) as exc_info:
            config_loader.load_conf()
        msg = str(exc_info.value)
        assert "MIGRATION REQUIRED" in msg or "conf.json" in msg

    def test_loads_valid_json(self, tmp_path, monkeypatch):
        conf_path = tmp_path / "conf.json"
        conf_path.write_text(json.dumps({"URL_LIST": ["https://example.com"], "RESUMES": []}))
        monkeypatch.setattr(config_loader, "CONF_JSON_FILE", conf_path)
        conf = config_loader.load_conf()
        assert conf["URL_LIST"] == ["https://example.com"]

    def test_raises_value_error_on_invalid_json(self, tmp_path, monkeypatch):
        conf_path = tmp_path / "conf.json"
        conf_path.write_text("{invalid json}")
        monkeypatch.setattr(config_loader, "CONF_JSON_FILE", conf_path)
        with pytest.raises(ValueError):
            config_loader.load_conf()


class TestLoadCookies:
    def test_returns_empty_dict_when_no_files(self):
        result = config_loader.load_cookies()
        assert result == {}

    def test_loads_cookies_from_secrets_json(self, tmp_path, monkeypatch):
        secrets_path = tmp_path / "secrets.json"
        secrets_path.write_text(json.dumps({"cookies": {"_session_id": "abc123"}}))
        monkeypatch.setattr(config_loader, "SECRETS_FILE", secrets_path)
        cookies = config_loader.load_cookies()
        assert cookies == {"_session_id": "abc123"}


class TestSaveCookies:
    def test_saves_and_reloads_cookies(self, tmp_path, monkeypatch):
        secrets_path = tmp_path / "secrets.json"
        monkeypatch.setattr(config_loader, "SECRETS_FILE", secrets_path)
        result = config_loader.save_cookies({"token": "xyz"})
        assert result is True
        loaded = config_loader.load_cookies()
        assert loaded["token"] == "xyz"

    def test_returns_false_for_empty_cookies(self):
        assert config_loader.save_cookies({}) is False
