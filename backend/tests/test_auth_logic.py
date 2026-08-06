import base64
import hashlib
import unittest
from unittest.mock import patch

import pandas as pd

from auth.identity import hierarchy_scope
from auth.passwords import verify_django_password
from core.scope import scope_df


def django_hash(password: str, salt: str = "test-salt", iterations: int = 600000) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${base64.b64encode(digest).decode()}"


class PasswordTests(unittest.TestCase):
    def test_accepts_matching_django_pbkdf2_password(self):
        self.assertTrue(verify_django_password("correct horse", django_hash("correct horse")))

    def test_rejects_wrong_unusable_and_unknown_hashes(self):
        encoded = django_hash("correct horse")
        self.assertFalse(verify_django_password("wrong", encoded))
        self.assertFalse(verify_django_password("anything", "!unusable"))
        self.assertFalse(verify_django_password("anything", "sha1$salt$value"))


class HierarchyTests(unittest.TestCase):
    def test_ho_and_branch_are_direct(self):
        self.assertEqual(hierarchy_scope({"designation_type": "HO"}), ("ho", None))
        self.assertEqual(
            hierarchy_scope({"designation_type": "B", "branch": "B001"}),
            ("branch", "B001"),
        )

    @patch("auth.identity._master_name")
    def test_sathi_designations_map_to_dashboard_hierarchy(self, master_name):
        master_name.side_effect = ["North", "Patna", "Cluster One", "Zone East"]
        self.assertEqual(
            hierarchy_scope({"designation_type": "T", "area_id": "U01"}),
            ("area", "North"),
        )
        self.assertEqual(
            hierarchy_scope({"designation_type": "R", "branch": "R01"}),
            ("region", "Patna"),
        )
        self.assertEqual(
            hierarchy_scope({"designation_type": "DC", "area_id": "CL01"}),
            ("cluster", "Cluster One"),
        )
        self.assertEqual(
            hierarchy_scope({"designation_type": "Z", "zone_id": "Z01"}),
            ("zone", "Zone East"),
        )

    def test_unknown_designation_is_fail_closed(self):
        self.assertEqual(
            hierarchy_scope({"designation_type": None}),
            ("branch", "__NO_SCOPE__"),
        )

    @patch("auth.identity._master_name", return_value="Legacy Zone")
    def test_zone_falls_back_to_area_id_for_legacy_sathi_profiles(self, _):
        self.assertEqual(
            hierarchy_scope({"designation_type": "Z", "zone_id": None, "area_id": "Z02"}),
            ("zone", "Legacy Zone"),
        )

    def test_mis_admin_role_does_not_bypass_sathi_data_scope(self):
        frame = pd.DataFrame({"zone_name": ["East", "West"], "amount": [10, 20]})
        scoped = scope_df(frame, {
            "role": "admin", "scope_level": "zone", "scope_value": "East",
        })
        self.assertEqual(scoped["amount"].tolist(), [10])


if __name__ == "__main__":
    unittest.main()
