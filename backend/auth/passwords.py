"""Minimal verifier for passwords produced by Django's PBKDF2 hasher."""

import base64
import hashlib
import hmac


def verify_django_password(password: str, encoded: str) -> bool:
    """Return False for unusable/unknown hashes without leaking hash details."""
    if not encoded or encoded.startswith("!"):
        return False
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = base64.b64encode(
            hashlib.pbkdf2_hmac(
                "sha256", password.encode(), salt.encode(), int(iterations)
            )
        ).decode()
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError):
        return False
