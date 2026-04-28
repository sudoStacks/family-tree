# Setup Historical Context Sources

This project supports multi-source historical context collection. Some APIs require free keys.

## Required Env Vars

Set these in your local `.env` file:

- `WHE_API_KEY` (World History Encyclopedia)
- `DPLA_API_KEY` (Digital Public Library of America)
- `EUROPEANA_API_KEY` (Europeana)

No key needed:

- Chronicling America (Library of Congress)
- Our World In Data
- Library of Congress Collections basic search

## How To Get Keys

### World History Encyclopedia

- URL: `worldhistory.org/affiliate/api/`
- Free for non-commercial use

### DPLA (Digital Public Library of America)

- URL: `dp.la/info/developers/codex/`
- Free and quick registration

### Europeana

- URL: `pro.europeana.eu/pages/get-api`
- Free and quick registration

## First-Time Build Order

1. Add keys to `.env`
2. `npm run fetch-sources -- --auto --resume`
3. `npm run build-context -- --resume`
4. `npm run book -- --surname smith --generation 3`

## Quarterly Refresh

- `npm run update-context`

Cron example (quarterly):

```bash
0 0 1 */3 * cd ~/family-tree && npm run update-context
```
