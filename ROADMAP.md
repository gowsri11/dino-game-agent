# Roadmap

Tracking for the "make it a better game" work. Each item is one commit.

| # | Item | Status |
|---|------|--------|
| 1 | Roadmap + tracking | done |
| 2 | Duck verb and high obstacles | done |
| 3 | Variable gaps so over-jumping is punished | todo |
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

**Tight gaps (3).** Today `MIN_GAP` is a constant 4, so landing late is always
safe and over-jumping costs nothing. Variable gaps make an oversized jump land on
the next obstacle, which is what gives width a consequence.

Solvability stays provable: the generator guarantees enough room after each
obstacle for a correctly-sized jump to land and for the landing cooldown to clear
before the next one.
