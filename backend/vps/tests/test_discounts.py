"""Pure integer allocation and backwards-compatible request fingerprints."""
import hashlib
import itertools
import random
import unittest

from discounts import (
    MAX_SALE_SATANG, allocate_discount, checkout_request_hash,
    legacy_checkout_request_hash,
)


class DiscountAllocationTests(unittest.TestCase):
    def check_totals(self, lines, discount):
        allocated = allocate_discount(lines, discount)
        self.assertEqual(sum(line.discount_satang for line in allocated), discount)
        self.assertEqual(sum(line.total_satang for line in allocated), sum(g for _, g in lines) - discount)
        for line in allocated:
            self.assertTrue(all(type(value) is int for value in line[1:]))
            self.assertTrue(0 <= line.discount_satang <= line.subtotal_satang)
            self.assertEqual(line.subtotal_satang, line.discount_satang + line.total_satang)
        return allocated

    def test_required_discount_amounts_and_full_discount(self):
        lines = [("c", 10000), ("a", 30000), ("b", 20000)]
        for discount in (0, 100, 17550, 60000):
            with self.subTest(discount=discount):
                self.check_totals(lines, discount)
        self.assertEqual([a.discount_satang for a in allocate_discount(lines, 100)], [50, 33, 17])
        self.assertEqual([a.discount_satang for a in allocate_discount(lines, 17550)], [8775, 5850, 2925])

    def test_largest_remainder_then_lot_id_breaks_ties(self):
        lines = [("c", 1), ("b", 1), ("a", 1)]
        expected = allocate_discount(lines, 2)
        self.assertEqual([a.discount_satang for a in expected], [1, 1, 0])
        for ordering in itertools.permutations(lines):
            self.assertEqual(allocate_discount(ordering, 2), expected)
        self.assertEqual([a.discount_satang for a in allocate_discount([("a", 1), ("b", 2)], 1)], [0, 1])

    def test_zero_price_lines_and_zero_subtotal(self):
        self.assertEqual([a.discount_satang for a in self.check_totals([("a", 0), ("b", 3), ("c", 0)], 2)], [0, 2, 0])
        self.check_totals([("a", 0), ("b", 0)], 0)
        with self.assertRaises(ValueError):
            allocate_discount([("a", 0)], 1)

    def test_integer_boundaries(self):
        self.check_totals([(str(i), 100_000_000_000) for i in range(50)], MAX_SALE_SATANG)
        with self.assertRaises(ValueError):
            allocate_discount([("a", MAX_SALE_SATANG), ("b", 1)], 0)

    def test_invalid_amounts_and_duplicate_lots(self):
        for invalid in (-1, True, False, 1.0, "1", None, MAX_SALE_SATANG + 1):
            with self.subTest(invalid_type=type(invalid).__name__):
                with self.assertRaises(ValueError):
                    allocate_discount([("a", 100)], invalid)
                with self.assertRaises(ValueError):
                    allocate_discount([("a", invalid)], 0)
        for lines, discount in (([("a", 1), ("a", 2)], 1), ([("a", 1)], 2), ([], 0)):
            with self.assertRaises(ValueError):
                allocate_discount(lines, discount)

    def test_exact_totals_for_exhaustive_small_and_seeded_large_carts(self):
        for gross in itertools.product(range(5), repeat=3):
            for discount in range(sum(gross) + 1):
                self.check_totals(list(zip(("c", "a", "b"), gross)), discount)
        rng = random.Random(734)
        for _ in range(200):
            lines = [(f"lot-{i:02}", rng.randrange(100_000_000_001)) for i in range(rng.randrange(1, 51))]
            self.check_totals(lines, rng.randrange(sum(g for _, g in lines) + 1))


class CheckoutFingerprintTests(unittest.TestCase):
    def setUp(self):
        self.items = [{"lot_id": "b", "quantity_mg": 2}, {"lot_id": "a", "quantity_mg": 1}]

    def test_omission_zero_order_and_reference_normalization(self):
        current = checkout_request_hash(self.items, "cash", " REF ")
        self.assertEqual(current, checkout_request_hash(list(reversed(self.items)), "cash", "REF", 0))
        self.assertNotEqual(current, checkout_request_hash(self.items, "cash", "REF", 1))
        self.assertNotEqual(current, checkout_request_hash(self.items, "transfer", "REF", 0))
        self.assertNotEqual(current, checkout_request_hash(self.items, "cash", "OTHER", 0))

    def test_exact_legacy_payload_format(self):
        original_bytes = b'{"authorization_ref":"REF","items":[{"lot_id":"a","quantity_mg":1},{"lot_id":"b","quantity_mg":2}],"payment_method":"cash"}'
        self.assertEqual(legacy_checkout_request_hash(self.items, "cash", "REF"), hashlib.sha256(original_bytes).hexdigest())
        self.assertNotEqual(legacy_checkout_request_hash(self.items, "cash", "REF"), checkout_request_hash(self.items, "cash", "REF", 0))


if __name__ == "__main__":
    unittest.main()
