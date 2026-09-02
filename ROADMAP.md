# Roadmap

Tracking for the "make it a better game" work. Each item is one commit.

| # | Item | Status |
|---|------|--------|
| 1 | Roadmap + tracking | done |
| 2 | Duck verb and high obstacles | done |
| 3 | Recovery cost scaled to commitment; variable gaps | done |
| 4 | Difficulty curve that does not plateau | done |
| 5 | Authored obstacle patterns | done |
| 6 | Seed sharing, high score, feedback | done |
| 7 | Headless benchmark harness | done |

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


## The difficulty curve (4)

Speed ramps 260ms -> 120ms over the first 350 steps and then floors. On its own
that means the game stops getting harder after about a minute, so a long run is
endurance rather than escalation.

Once speed floors, density takes over: obstacles get likelier and the random
slack in the gaps is squeezed out, over the following 900 steps. The gap floor
itself is never crossed, so lanes stay provably clearable no matter how long a
run goes on - which does mean difficulty is bounded. It has to be: an unbounded
curve eventually produces a lane no player can clear.


## Authored patterns (5)

A memoryless per-cell coin flip produces statistically uniform terrain: every run
feels the same and nothing is memorable. Lanes are now built from authored chunks
in `public/patterns.js`, gated by tier so shapes are introduced over time -
singles first, then pairs and mixed over/under sequences, then gauntlets.

Tiers unlock on their own schedule (every 120 steps) rather than following the
density curve, which does not start moving until the speed ramp has floored. Tied
to density, the opening minutes would have been nothing but single obstacles.

Patterns list obstacles only. The generator inserts the required gap after each
one, so a pattern cannot express an unclearable spacing even by mistake - the
invariant is structural rather than something each pattern has to get right.


## Benchmark findings (7)

`npm run bench -- --policy <name> --seeds N` runs headlessly: `engine.js` is pure,
so no browser is involved. It runs in virtual time - a policy call is awaited, the
real latency measured, and the world advanced by the steps that latency would have
cost - so a slow model loses exactly the steps it would lose in the browser while
the benchmark finishes as fast as the calls allow.

First results, and they revise an earlier conclusion:

| policy | seeds | cap | result |
|---|---|---|---|
| heuristic | 25 | 1500 | 25/25 reached the cap, 0 missed |
| llm-batch | 3 | 300 | 3/3 reached the cap, 75 missed |
| llm | 3 | 300 | 3/3 reached the cap, 0 missed |
| llm | 1 | 900 | reached the cap, 8 fallbacks from transient errors |

Earlier, per-obstacle died around score 37 while batch survived past 183, and the
redundancy of re-planning was credited for the gap. That gap has closed: both
policies now clear every run attempted. The likely cause is the phantom-obstacle
fix - the observer was inventing a spurious narrow obstacle behind any obstacle
half past the player, and acting on it corrupted the real action. Per-obstacle had
no redundancy to absorb that; batch did. With the bug gone, the redundancy is no
longer load-bearing.

Caveat worth keeping in mind: every policy above *reached the cap*, so the cap is
the limiting factor, not the policy. These runs do not rank them. Separating them
needs longer runs or a harder starting difficulty, which is what the harness is
for.
