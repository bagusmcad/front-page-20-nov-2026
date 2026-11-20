[![news-image-20261120](https://make.fun/badge/news-image-20261120.svg)](https://make.fun/bounty/news-image-20261120)
[![rank](https://make.fun/badge/news-image-20261120/bagusmcad/front-page-20-nov-2026/rank.svg)](https://make.fun/bounty/news-image-20261120)
[![reward](https://make.fun/badge/news-image-20261120/bagusmcad/front-page-20-nov-2026/reward.svg)](https://make.fun/bounty/news-image-20261120)

# Friday 20 November 2026 in one page

A one-page newspaper front page of Friday 20 November 2026, drawn entirely by code.
`main.ts` (Node 22, standard library only, no network) renders a 1024x1024 PNG:
a masthead naming the day, 43 stories with headlines and short decks, 13 illustrated
stories, a world map with numbered pins, and a 30-item digest. The image in this
repo (`entry.png`) is the program's own output, so the repo and the program agree.

## What the image shows

43 stories, all from Friday 20 November 2026, led by the ICJ ruling that Myanmar
committed genocide against the Rohingya, the Trump-Xi-Putin peace declaration from
Shenzhen, and Anthropic's stock-market debut (shares +34%, about a $2T valuation).

## Validation and limitations

- `entry.png` is byte-identical across two runs of `main.ts` (deterministic).
- Every story was verified against the prep file's sources; the one unverified
  claim found during research (a claimed cyber-attack on Visa/Mastercard) was left
  out entirely.
- The image is drawn entirely by code (own bitmap font + own PNG encoder); no
  photographs are used, so scenes are illustrations, not records of the events.
