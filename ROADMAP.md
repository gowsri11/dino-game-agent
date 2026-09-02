# Roadmap

Tracking for the "make it a better game" work. Each item is one commit.

| # | Item | Status |
|---|------|--------|
| 1 | Roadmap + tracking | done |
| 2 | Duck verb and high obstacles | done |
| 3 | Recovery cost scaled to commitment; variable gaps | done |
| 4 | Difficulty curve that does not plateau | todo |
| 5 | Authored obstacle patterns | todo |
| 6 | Seed sharing, high score, feedback | todo |
| 7 | Headless benchmark harness | todo |

## Why not "double the grid resolution"

Proposed first, then dropped. The idea was that finer cells would let a jump be
both forgiving and width-specific. It does not: airtime is `width + margin`, so a
jump sized for width W always also clears width `W + margin`. Doubling resolution
doubles the width steps (2/4/6 cells) but the margin has to double too to keep the
same forgiveness in real time, so the collapse returns unchanged.

Forgiveness and width-discrimination are the same quantity in a discrete grid.
Resolution only buys smoother visuals, so it is not worth the churn through the
engine, observer, agent scheduling and prompts.

## What creates skill expression instead

**A second verb (2).** A high obstacle needs a different action, not a
differently-sized one, so it is distinguishable with no timing margin at all.
Three responses - tap, double-tap, duck - where there were two.

**Recovery cost (3).** Punishing an oversized jump with a tight gap turns out to
be impossible: solvability needs a wide gap (the player must land and recover
before the next obstacle) and punishment needs a narrow one. Directly
contradictory.

What works instead is charging recovery in proportion to the width committed to.
An oversized action succeeds but leaves the player still recovering when the next
obstacle lands. The cost is `2 x width`, deliberately superlinear: a linear cost
lands exactly on the solvability boundary, where a correctly-sized action only
just survives and any off-by-one breaks it. Doubling gives a correct action one
cell of slack and makes an oversized one miss by two.

Gaps are `2 x width + 3` plus random slack, so the punishment bites at the
tightest spacing and wide sections stay forgiving.
