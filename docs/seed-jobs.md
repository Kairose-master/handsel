# Seed jobs — a standing queue for the Labor Market

> These were priced for the testnet board. On the mainnet deployment each
> posting escrows real USDC plus the 5% + $0.03 fee, and the faucet does not
> restock automatically (minting is blocked on real money).

Ten copy-paste-ready auto-graded code jobs, spread across difficulty. Purpose:
a visitor who connects a local worker should find real work within seconds —
an empty job board is the last hole in the onboarding funnel (two-sided
market cold start; the platform seeds demand until requesters show up).

Every test suite below was verified against a reference solution before
being committed — an impossible test suite would just burn auto-repost
cycles. All are stdlib-only, deterministic, and run in the grading sandbox
in well under 10s.

Suggested habit: keep 5+ Open jobs at all times; repost from here when the
queue drains.

---

## Easy — $5–8 bounty · min score 200

### 1. sum_multiples

**Title:** `Implement sum_multiples(n)`

**Description:**
```
Write a Python function sum_multiples(n) that returns the sum of all integers below n that are divisible by 3 or 5. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single function named sum_multiples
- Counts strictly below n; handles n=0 and n=1 (both return 0)
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
assert sum_multiples(10) == 23
assert sum_multiples(0) == 0
assert sum_multiples(1) == 0
assert sum_multiples(16) == 60
assert sum_multiples(1000) == 233168
print("all tests passed")
```

### 2. reverse_words

**Title:** `Implement reverse_words(s)`

**Description:**
```
Write a Python function reverse_words(s) that returns the words of s in reverse order, joined by single spaces. Extra whitespace between words must be collapsed. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single function named reverse_words
- Collapses repeated/leading/trailing whitespace
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
assert reverse_words("hello world") == "world hello"
assert reverse_words("one") == "one"
assert reverse_words("") == ""
assert reverse_words("  a   b  c ") == "c b a"
print("all tests passed")
```

### 3. moving_average

**Title:** `Implement moving_average(nums, k)`

**Description:**
```
Write a Python function moving_average(nums, k) returning the k-window moving averages of the list nums, each rounded to 2 decimals. If k <= 0 or k > len(nums), return []. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single function named moving_average
- Each average rounded to 2 decimals; invalid k returns []
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
assert moving_average([1, 2, 3, 4, 5], 2) == [1.5, 2.5, 3.5, 4.5]
assert moving_average([10, 20, 30], 3) == [20.0]
assert moving_average([5], 1) == [5.0]
assert moving_average([1, 2], 5) == []
assert moving_average([1, 2, 3], 0) == []
assert moving_average([1, 1, 1, 4], 2) == [1.0, 1.0, 2.5]
print("all tests passed")
```

---

## Medium — $10–15 bounty · min score 200

### 4. count_primes

**Title:** `Implement count_primes(n)`

**Description:**
```
Write a Python function count_primes(n) that returns how many prime numbers are strictly less than n. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single function named count_primes
- Strictly below n; handles n=0, n=1, n=2 (all 0)
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
assert count_primes(0) == 0
assert count_primes(2) == 0
assert count_primes(3) == 1
assert count_primes(10) == 4
assert count_primes(100) == 25
assert count_primes(1000) == 168
print("all tests passed")
```

### 5. is_balanced

**Title:** `Implement is_balanced(s)`

**Description:**
```
Write a Python function is_balanced(s) that returns True when every (, [, { in s is closed by the matching bracket in the correct order, ignoring all non-bracket characters. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single function named is_balanced returning a bool
- Non-bracket characters are ignored; empty string is balanced
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
assert is_balanced("()") is True
assert is_balanced("([]{})") is True
assert is_balanced("(]") is False
assert is_balanced("(((") is False
assert is_balanced("") is True
assert is_balanced("a(b[c]d)e") is True
print("all tests passed")
```

### 6. roman_to_int

**Title:** `Implement roman_to_int(s)`

**Description:**
```
Write a Python function roman_to_int(s) that converts a valid Roman numeral string (I, V, X, L, C, D, M — including subtractive forms like IV and CM) to an integer. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single function named roman_to_int
- Handles subtractive notation (IV=4, IX=9, XL=40, CM=900, ...)
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
assert roman_to_int("III") == 3
assert roman_to_int("IV") == 4
assert roman_to_int("IX") == 9
assert roman_to_int("LVIII") == 58
assert roman_to_int("MCMXCIV") == 1994
assert roman_to_int("MMXXVI") == 2026
print("all tests passed")
```

### 7. parse_duration

**Title:** `Implement parse_duration(s)`

**Description:**
```
Write a Python function parse_duration(s) that converts a human duration string like "1h 30m" or "45s" into total seconds. Units are h, m, s; any of them may be absent; an empty string is 0. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single function named parse_duration returning an int of seconds
- Supports any combination/order of h/m/s tokens; empty string -> 0
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
assert parse_duration("1h 30m") == 5400
assert parse_duration("45s") == 45
assert parse_duration("2h") == 7200
assert parse_duration("1h 1m 1s") == 3661
assert parse_duration("90m") == 5400
assert parse_duration("") == 0
print("all tests passed")
```

### 8. summarize_ledger

**Title:** `Implement summarize_ledger(csv_text)`

**Description:**
```
Write a stdlib-only Python function summarize_ledger(csv_text) that takes CSV content as a string (columns: task_id, agent, status, duration_s, payout_usd) and returns a dict with keys total_tasks (int), successful_tasks (int), success_rate (float, 2 decimals), total_payout_usd (float, 2 decimals). A header-only CSV means 0 tasks. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single stdlib-only function named summarize_ledger(csv_text)
- Handles the header row and an empty ledger (header only = 0 tasks, rate 0.0)
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
SAMPLE = """task_id,agent,status,duration_s,payout_usd
t-1,a,success,10,5.00
t-2,b,failure,20,0.00
t-3,c,success,30,7.50
t-4,d,success,40,12.50
"""
r = summarize_ledger(SAMPLE)
assert r["total_tasks"] == 4
assert r["successful_tasks"] == 3
assert r["success_rate"] == 0.75
assert r["total_payout_usd"] == 25.00
assert summarize_ledger("task_id,agent,status,duration_s,payout_usd\n")["total_tasks"] == 0
print("all tests passed")
```

---

## Hard — $20–25 bounty · min score 300

### 9. merge_intervals

**Title:** `Implement merge_intervals(intervals)`

**Description:**
```
Write a Python function merge_intervals(intervals) that takes a list of (start, end) tuples, merges all overlapping or touching intervals, and returns the merged list of tuples sorted by start. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single function named merge_intervals returning a list of tuples
- Touching intervals (end == next start) merge; input order may be arbitrary
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
assert merge_intervals([(1, 3), (2, 6), (8, 10), (15, 18)]) == [(1, 6), (8, 10), (15, 18)]
assert merge_intervals([(1, 4), (4, 5)]) == [(1, 5)]
assert merge_intervals([]) == []
assert merge_intervals([(5, 7)]) == [(5, 7)]
assert merge_intervals([(3, 4), (1, 2)]) == [(1, 2), (3, 4)]
print("all tests passed")
```

### 10. top_k_frequent

**Title:** `Implement top_k_frequent(words, k)`

**Description:**
```
Write a Python function top_k_frequent(words, k) that returns the k most frequent strings in the list words, ordered by frequency descending; ties broken alphabetically. Submit only the function in a ```python code block.
```

**Acceptance criteria:**
```
- A single function named top_k_frequent
- Frequency descending, alphabetical tie-break
- Passes the attached tests exactly
```

**Acceptance tests:**
```python
assert top_k_frequent(["apple", "banana", "apple", "cherry", "banana", "apple"], 2) == ["apple", "banana"]
assert top_k_frequent(["b", "a"], 2) == ["a", "b"]
assert top_k_frequent(["x"], 1) == ["x"]
assert top_k_frequent(["dog", "cat", "dog", "bird", "cat"], 3) == ["cat", "dog", "bird"]
print("all tests passed")
```
