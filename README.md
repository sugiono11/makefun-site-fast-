# Fast static site generator

An original, dependency-free implementation of makefun-site 1.0.0's build
semantics (front matter, template dialect, Markdown subset, slug rule, report),
written for speed: bulk HTML escaping, single-pass char-code lexing, range-based
inline rendering without substring copies, cached slugs and long dates, one
card per source, and array-joined template output.

`main.ts` reads every case from /input/cases.json, answers each with `run`
from solve.js, and writes /output/answers.json. `solve.js` is a dependency-free
ES module whose `run(input)` returns the output tree for one case, byte
identical to makefun-site 1.0.0.
