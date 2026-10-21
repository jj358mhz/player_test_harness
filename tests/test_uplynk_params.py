"""The Params rules: Python (presets) and TypeScript (the player) agree."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.uplynk import params

TS = Path(__file__).parents[1] / "frontend" / "src" / "lib" / "uplynkParams.ts"


def _ts_source() -> str:
    return TS.read_text()


def test_keys_match_the_player_menu():
    src = _ts_source()
    menu = set(re.findall(r"""^\s*p\(\s*'([^']+)'""", src, re.M))
    menu |= set(re.findall(r"""^\s*p\(\s*\n\s*'([^']+)'""", src, re.M))
    prefixes = tuple(re.findall(r"'([a-z]+\.)'", src.split("PARAM_PREFIXES = [")[1].split("]")[0]))
    assert prefixes == params.PARAM_PREFIXES
    assert {k for k in menu if not k.startswith(prefixes)} == params.PARAM_KEYS
    assert all(params.is_param_key(k) for k in menu)


def test_reserved_and_patterns_match():
    src = _ts_source()
    for key in params.RESERVED:
        if params.RESERVED[key].endswith("is part of the token"):
            assert f"'{key}'" in src
        else:
            assert re.search(rf"^\s*'?{key}'?: ", src, re.M), key
    for name in ("KEY_RE", "VALUE_RE", "EXPAND_RE"):
        ts = re.search(rf"const {name} = /(.+)/;", src).group(1)
        assert ts == getattr(params, name).pattern, name
    assert f"MAX_PARAMS = {params.MAX_PARAMS};" in src


def test_check_params():
    assert params.check_params([("expand", "ad_01"), ("ad.lib", "KOR")], has_ad=False) == [
        ("expand", "ad_01"),
        ("ad.lib", "KOR"),
    ]
    assert params.check_params([("rmp.policy_overrides.can_play", "False")], has_ad=False)
    for pairs, message in [
        ([("ad.lib", "KOR")], "needs an ad server"),
        ([("delay", "20")], "Delay menu"),
        ([("tc", "1")], "part of the token"),
        ([("nope", "1")], "isn't a param"),
        ([("ad.", "1")], "isn't a param"),
        ([("ifo", "<x>")], "characters"),
        ([("expand", "a,,b")], "set names"),
        ([(f"ad.k{i}", "1") for i in range(21)], "at most 20"),
    ]:
        with pytest.raises(params.ParamError, match=message):
            params.check_params(pairs, has_ad=message != "needs an ad server")
