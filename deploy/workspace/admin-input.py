#!/usr/bin/env python3
"""Operator terminal only. stdout contains ONLY JSON for the CLI stdin."""
import getpass
import json
import sys
import warnings

if not sys.stdin.isatty():
    raise SystemExit("Run from an operator terminal; no password from argv/env")
warnings.simplefilter("error", getpass.GetPassWarning)

def prompt(text):
    print(text, end="", file=sys.stderr, flush=True)
    value = sys.stdin.readline()
    if not value:
        raise SystemExit("Input cancelled")
    return value.strip()

username = prompt("Admin username (3-32 letters/digits/underscore/dot/hyphen): ")
name = prompt("Display name: ")
password = getpass.getpass("Password (12+ chars): ")
confirmation = getpass.getpass("Confirm password: ")
if password != confirmation:
    raise SystemExit("Passwords differ")
print(json.dumps({"username": username, "name": name, "password": password}))
