# Reasoning on or off: 2026-10-24-strict-ids

Counts summed over every report in this folder (both groups, every repeat). Each repeat is a live sample; small counts.

## 16k-reason (3 repeat(s), 27 min in all)

| | speck-desk/nemotron | speck-fresh/nemotron | baseline-stateless/nemotron |
|---|---|---|---|
| conclusion correct | 26/48 | 26/48 | 32/48 |
| abstained when a conclusion was due | 21/30 | 21/30 | 3/30 |
| unsupported claims (of conclusions) | 1/9 | 1/9 | 2/37 |
| refuted claim kept out of current | 26/27 | 26/27 | 27/27 |
| invalidated evidence kept out of support | 15/15 | 14/15 | 14/15 |
| valid citations | 96/109 | 98/101 | 70/77 |
| model replies valid | 94/95 | 114/116 | 42/54 |
| median call latency, ms (per report) | 3575/4512/6191/5128/3959/5028 | 5227/5657/6283/6117/7052/4995 | 1872/2003/1794/2163/1574/1664 |

## 4k-noreason (3 repeat(s), 15 min in all)

| | speck-desk/nemotron | speck-fresh/nemotron | baseline-stateless/nemotron |
|---|---|---|---|
| conclusion correct | 26/48 | 27/48 | 19/48 |
| abstained when a conclusion was due | 22/30 | 21/30 | 1/30 |
| unsupported claims (of conclusions) | 0/8 | 0/9 | 19/44 |
| refuted claim kept out of current | 27/27 | 27/27 | 19/27 |
| invalidated evidence kept out of support | 15/15 | 15/15 | 10/15 |
| valid citations | 109/111 | 109/113 | 87/87 |
| model replies valid | 94/95 | 112/120 | 48/48 |
| median call latency, ms (per report) | 1911/1815/1868/1841/2370/1865 | 2275/2615/2217/2409/2338/2518 | 689/652/691/667/684/685 |

