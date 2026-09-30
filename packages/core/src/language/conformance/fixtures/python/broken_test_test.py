def subtract(a: int, b: int) -> int:
    return a - b


def test_subtract_intentionally_wrong():
    # Deliberately wrong: 5 - 3 is 2, not 10. This must fail.
    assert subtract(5, 3) == 10
