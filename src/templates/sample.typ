#import "/notebook.typ": *
#show: notebook.with(title: "Hello, Reactive Typst", kernel: "python")

= Welcome

This notebook combines *Typst* typesetting with *Pyodide*-powered live cells.
Edit either the prose or the code; the affected cells re-run automatically.

== A first computation

#cell(id: "primes", lang: "python")[```python
def primes_below(n):
    sieve = [True] * n
    sieve[:2] = [False, False]
    for i in range(2, int(n ** 0.5) + 1):
        if sieve[i]:
            for j in range(i * i, n, i):
                sieve[j] = False
    return [i for i, p in enumerate(sieve) if p]

ps = primes_below(50)
print("first ten:", ps[:10])
ps
```]

== Downstream cell

This cell consumes `ps` from above. Try changing the limit in the cell above
from `50` to `200` and watch this cell re-execute on its own.

#cell(id: "summary", lang: "python")[```python
print("count:", len(ps))
print("largest:", ps[-1])
```]

== Notes

Cells share Python-runtime state (`ps` flows from one to the next) and Typst
document state (this section's heading numbering carries through).
