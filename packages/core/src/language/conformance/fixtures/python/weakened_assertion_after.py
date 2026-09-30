def test_compute_total():
    # assert count dropped from 2 to 1 — this is what
    # checkTestIntegrity's Python AST visitor is built to flag.
    assert compute_total([1, 2, 3]) == 6
