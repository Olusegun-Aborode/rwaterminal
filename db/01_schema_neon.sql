-- =============================================================================
-- RWA TERMINAL — CANONICAL SCHEMA (Postgres + TimescaleDB)
-- Version 1.0 (NEON / plain PostgreSQL — no TimescaleDB extension)
-- Source of truth for the data model. The indexer's schema.graphql is a DERIVED
-- projection of this file, never the reverse.
--
-- Spine:  issuer -> asset -> token
-- Tags:   curator, venue, asset_class, chain, custody, regulatory_wrapper, yield_source
-- Rule:   identity is the contract address, never the ticker.
-- Rule:   AUM/NAV/yield live on ASSET; supply/holders/transfers live on TOKEN.
-- Rule:   Aave Horizon is a VENUE row, not a parent.
-- =============================================================================

-- (no timescaledb on Neon; plain tables + btree indexes instead)

-- =============================================================================
-- 1. CHAINS
-- =============================================================================
CREATE TABLE chain (
    chain_id            INTEGER PRIMARY KEY,          -- EVM chainId (Ethereum = 1)
    name                TEXT NOT NULL,
    short_name          TEXT,
    is_evm              BOOLEAN NOT NULL DEFAULT TRUE,
    finality_depth      INTEGER NOT NULL DEFAULT 64,  -- blocks until "final" for headline metrics
    explorer_url        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- 2. ENTITY DIMENSIONS (the people/orgs/structures behind assets)
-- =============================================================================

-- Issuer / investment manager. NOTE: issuer and manager are SEPARATE roles.
-- (USTB: Superstate issues; Invesco becoming manager.) Model the relationship
-- on the asset, not here, so both can be referenced independently.
CREATE TABLE issuer (
    issuer_id           BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    legal_name          TEXT,
    type                TEXT,                          -- 'asset_manager' | 'fintech' | 'bank' | ...
    website             TEXT,
    data_source_url     TEXT,                          -- issuer API / docs for off-chain reconciliation
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tokenization platform (Securitize, Centrifuge). Distinct from issuer.
CREATE TABLE tokenization_platform (
    platform_id         BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    website             TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transfer agent (legal record-keeper of ownership; may differ from chain).
CREATE TABLE transfer_agent (
    transfer_agent_id   BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    notes               TEXT
);

-- =============================================================================
-- 3. TAG DIMENSIONS (the seven lenses, as first-class dimension tables)
-- =============================================================================

-- Asset class. Classify by ECONOMIC EXPOSURE (rwa.xyz framework), e.g. a CLO is
-- classified by underlying corporate-loan exposure, not the structured wrapper.
CREATE TABLE asset_class (
    asset_class_id      BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,          -- 'us_treasuries' | 'private_credit' | 'mmf' | 'equities' | 'real_estate' | 'commodities' | 'stablecoin' | ...
    parent_class_id     BIGINT REFERENCES asset_class(asset_class_id),
    description         TEXT
);

-- Venue: where a token is used/traded. Aave Horizon is a row here.
CREATE TABLE venue (
    venue_id            BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,          -- 'Aave Horizon' | 'Morpho:<market>' | 'Uniswap v3' | ...
    venue_type          TEXT NOT NULL,                 -- 'lending_market' | 'dex' | 'primary_issuance' | 'ats'
    chain_id            INTEGER REFERENCES chain(chain_id),
    protocol            TEXT,                          -- 'aave_v3.3' | 'morpho_blue' | ...
    pool_address        TEXT,                          -- e.g. Horizon Pool 0xAe05Cd...332C8
    market_id           TEXT,                          -- e.g. 'proto_horizon_v3'
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DeFi vault curator (Steakhouse, Gauntlet) — the precise technical sense.
-- Separate from venue and from issuer.
CREATE TABLE curator (
    curator_id          BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    curator_type        TEXT NOT NULL DEFAULT 'vault_curator', -- 'vault_curator' | 'risk_provider'
    website             TEXT
);

CREATE TABLE custody (
    custody_id          BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,          -- 'BNY Mellon' | 'State Street' | 'Pershing' | ...
    custody_type        TEXT                           -- 'offchain_custodian' | 'digital_custodian' | 'fund_admin'
);

CREATE TABLE regulatory_wrapper (
    wrapper_id          BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,          -- 'Reg D 506(c)' | 'Reg S' | "'40 Act" | '3(c)(7)' | ...
    domicile            TEXT,                          -- 'BVI' | 'Cayman' | 'Luxembourg' | 'Singapore' | 'US'
    description         TEXT
);

CREATE TABLE yield_source (
    yield_source_id     BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,          -- 't_bills' | 'clo_spread' | 'crypto_carry' | 'rental_income' | ...
    description         TEXT
);

CREATE TABLE oracle_provider (
    oracle_provider_id  BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE           -- 'Chainlink NAVLink' | 'RedStone TSSO' | 'Superstate NAV' | ...
);

-- =============================================================================
-- 4. ASSET (the economic fund/instrument — ONE NAV, ONE manager, ONE yield)
-- =============================================================================
CREATE TABLE asset (
    asset_id            BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL,                 -- 'Anemoy Treasury Fund' (fund name, not ticker)
    display_ticker      TEXT,                          -- DISPLAY ONLY — never used for joins/identity
    issuer_id           BIGINT NOT NULL REFERENCES issuer(issuer_id),
    investment_manager_id BIGINT REFERENCES issuer(issuer_id),  -- may differ from issuer
    platform_id         BIGINT REFERENCES tokenization_platform(platform_id),
    transfer_agent_id   BIGINT REFERENCES transfer_agent(transfer_agent_id),
    isin                TEXT,
    redemption_terms    JSONB,                         -- { who, frequency, settlement: 'T+1', minimum, mechanism }
    settlement_cycle    TEXT,                          -- 'T+0' | 'T+1' | 'T+2'
    rating              TEXT,                          -- e.g. S&P tokenized-fund rating
    -- NOTE: distributed_or_represented MOVED to `token` (below). The lint says
    -- "tag every TOKEN": whether a deployment can leave its issuing platform and
    -- move peer-to-peer is a per-deployment property, not a fund-level one. One
    -- asset's token can be Distributed on chain A and Represented on chain B
    -- (e.g. multi-chain, per-ecosystem-compliance assets such as sACRED).
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- 5. TOKEN (a contract deployment on a specific chain; one ASSET -> many TOKENS)
-- =============================================================================
CREATE TABLE token (
    token_id            BIGSERIAL PRIMARY KEY,
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    chain_id            INTEGER NOT NULL REFERENCES chain(chain_id),
    -- IDENTITY. Store ONE canonical form: the address LOWERCASED (EIP-55 mixed-case
    -- checksum stripped). "lowercase-checksummed" was a contradiction in terms —
    -- lowercase is by definition not checksummed. Everything that ingests an address
    -- must .toLowerCase() before insert/lookup, or case-sensitive joins silently miss.
    contract_address    TEXT NOT NULL,                 -- lowercased; unique per chain
    token_standard      TEXT,                          -- 'ERC20' | 'ERC4626' | 'ERC7540'
    decimals            SMALLINT,
    symbol              TEXT,                          -- display only
    distributed_or_represented TEXT,                   -- 'distributed' | 'represented' (rwa.xyz framework) — per TOKEN
    is_wrapper          BOOLEAN NOT NULL DEFAULT FALSE,
    -- TOKEN-LEVEL wrap (1:1 token redeems to another token): Base deJAAA -> JAAA,
    -- sACRED -> ACRED. Used to net TOKEN metrics (supply/transfers), NOT AUM.
    -- ASSET-LEVEL "holds/feeds" double-counts (OUSG holds BUIDL; ACRED feeds ADCF)
    -- are netted separately via asset_holds_asset (see junctions) because they hit
    -- the asset-level AUM headline, not token supply.
    wraps_token_id      BIGINT REFERENCES token(token_id),
    oracle_provider_id  BIGINT REFERENCES oracle_provider(oracle_provider_id),
    nav_aggregator_addr TEXT,                          -- AggregatorV3Interface feed for NAV/price
    nav_heartbeat_secs  INTEGER NOT NULL DEFAULT 86400, -- expected update cadence; daily default so the
                                                       -- staleness writer always has a threshold (null would mute it)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chain_id, contract_address)
);

-- =============================================================================
-- 6. JUNCTION TABLES (the many-to-many tag layer)
-- =============================================================================
CREATE TABLE asset_asset_class (
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    asset_class_id      BIGINT NOT NULL REFERENCES asset_class(asset_class_id),
    is_primary          BOOLEAN NOT NULL DEFAULT TRUE, -- dominant-exposure rule
    PRIMARY KEY (asset_id, asset_class_id)
);

CREATE TABLE asset_venue (
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    venue_id            BIGINT NOT NULL REFERENCES venue(venue_id),
    role                TEXT,                          -- 'collateral' | 'borrowable' | 'traded' | 'listed'
    first_seen          TIMESTAMPTZ,
    PRIMARY KEY (asset_id, venue_id, role)
);

CREATE TABLE asset_curator (
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    curator_id          BIGINT NOT NULL REFERENCES curator(curator_id),
    PRIMARY KEY (asset_id, curator_id)
);

CREATE TABLE curator_market (
    curator_id          BIGINT NOT NULL REFERENCES curator(curator_id),
    venue_id            BIGINT NOT NULL REFERENCES venue(venue_id),
    PRIMARY KEY (curator_id, venue_id)
);

CREATE TABLE asset_custody (
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    custody_id          BIGINT NOT NULL REFERENCES custody(custody_id),
    PRIMARY KEY (asset_id, custody_id)
);

CREATE TABLE asset_regulatory_wrapper (
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    wrapper_id          BIGINT NOT NULL REFERENCES regulatory_wrapper(wrapper_id),
    PRIMARY KEY (asset_id, wrapper_id)
);

CREATE TABLE asset_yield_source (
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    yield_source_id     BIGINT NOT NULL REFERENCES yield_source(yield_source_id),
    PRIMARY KEY (asset_id, yield_source_id)
);

-- ASSET-LEVEL holdings graph (anti-double-count for the AUM headline).
-- When one asset's portfolio holds another tokenized RWA that is ALSO in this
-- dataset, summing both asset-level AUMs double-counts the overlap. Known cases:
--   OUSG  holds BUIDL        (relationship 'holds')
--   ACRED feeds  ADCF        (relationship 'feeds'  — feeder fund)
-- `overlap_fraction` is the share of the holder's AUM represented by the held
-- asset (1.0 = pure feeder/wrapper, e.g. ACRED->ADCF). The headline view nets
-- min(overlap) out so exposure is counted once. Distinct from token.wraps_token_id,
-- which is a 1:1 token redemption used to net TOKEN metrics, not AUM.
CREATE TABLE asset_holds_asset (
    holder_asset_id     BIGINT NOT NULL REFERENCES asset(asset_id),
    held_asset_id       BIGINT NOT NULL REFERENCES asset(asset_id),
    relationship        TEXT NOT NULL DEFAULT 'holds',  -- 'holds' | 'feeds' | 'wraps'
    overlap_fraction    NUMERIC NOT NULL DEFAULT 1.0,    -- 0..1 share of holder AUM that is the held asset
    PRIMARY KEY (holder_asset_id, held_asset_id),
    CHECK (holder_asset_id <> held_asset_id)
);

-- =============================================================================
-- 7. VENUE POSITION STATE (e.g. Horizon reserve config per asset)
-- =============================================================================
CREATE TABLE venue_reserve (
    venue_reserve_id    BIGSERIAL PRIMARY KEY,
    venue_id            BIGINT NOT NULL REFERENCES venue(venue_id),
    token_id            BIGINT NOT NULL REFERENCES token(token_id),
    a_token_address     TEXT,                          -- RwaAToken (non-transferable) or aToken
    variable_debt_addr  TEXT,
    ltv                 NUMERIC,                       -- loan-to-value
    liquidation_thresh  NUMERIC,
    is_collateral       BOOLEAN,
    is_borrowable       BOOLEAN,
    UNIQUE (venue_id, token_id)
);

-- =============================================================================
-- 8. TIME-SERIES (TimescaleDB hypertables) — keyed (entity_id, ts)
-- NAV history stores BOTH ingest ts AND on-chain updatedAt so staleness is
-- historically queryable.
-- =============================================================================
CREATE TABLE asset_nav_history (
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    ts                  TIMESTAMPTZ NOT NULL,          -- ingest time
    nav                 NUMERIC NOT NULL,
    source              TEXT NOT NULL,                 -- 'onchain_oracle' | 'issuer_reported'
    updated_at_onchain  TIMESTAMPTZ,                   -- AggregatorV3 updatedAt
    round_id            NUMERIC,
    is_stale            BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (asset_id, ts)
);


CREATE TABLE asset_aum_history (
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    ts                  TIMESTAMPTZ NOT NULL,
    aum                 NUMERIC NOT NULL,
    source              TEXT NOT NULL,                 -- 'onchain_derived' | 'issuer_reported'
    PRIMARY KEY (asset_id, ts)
);


CREATE TABLE asset_yield_history (
    asset_id            BIGINT NOT NULL REFERENCES asset(asset_id),
    ts                  TIMESTAMPTZ NOT NULL,
    apy_7d              NUMERIC,
    apy_30d             NUMERIC,
    method              TEXT,                          -- 'sec_7day_nav' | 'sec_7day_distributing' | ...
    PRIMARY KEY (asset_id, ts)
);


CREATE TABLE token_supply_history (
    token_id            BIGINT NOT NULL REFERENCES token(token_id),
    ts                  TIMESTAMPTZ NOT NULL,
    total_supply        NUMERIC NOT NULL,
    circulating         NUMERIC,
    PRIMARY KEY (token_id, ts)
);


CREATE TABLE token_holder_history (
    token_id            BIGINT NOT NULL REFERENCES token(token_id),
    ts                  TIMESTAMPTZ NOT NULL,
    holder_count        INTEGER NOT NULL,
    top10_share         NUMERIC,                       -- holder concentration
    PRIMARY KEY (token_id, ts)
);


-- Secondary-market PRICE per token (distinct from asset NAV). Required for
-- premium/discount = (price - NAV) / NAV, which the dashboard specifies but had
-- nowhere to live. Only populated where a real secondary market exists; NAV stays
-- on asset_nav_history. Premium/discount is a per-TOKEN computation (this price vs
-- the parent asset's NAV).
CREATE TABLE token_price_history (
    token_id            BIGINT NOT NULL REFERENCES token(token_id),
    ts                  TIMESTAMPTZ NOT NULL,
    price               NUMERIC NOT NULL,
    source              TEXT NOT NULL,                 -- 'dex_twap' | 'cex' | 'oracle' | ...
    PRIMARY KEY (token_id, ts)
);


-- Transfer VOLUME / turnover per token. The dashboard lists transfer volume and
-- turnover (volume / asset value) as per-token metrics but no table held them.
-- For RWA aTokens there are no free Transfer events, so volume is derived from
-- Mint/Burn/BalanceTransfer (see ingestion spec) — record the method.
CREATE TABLE token_transfer_history (
    token_id            BIGINT NOT NULL REFERENCES token(token_id),
    ts                  TIMESTAMPTZ NOT NULL,
    transfer_volume     NUMERIC NOT NULL,              -- in token units over the bucket
    transfer_count      INTEGER,
    method              TEXT,                          -- 'erc20_transfer' | 'mint_burn_balancetransfer'
    PRIMARY KEY (token_id, ts)
);


-- Venue market state over time (utilization, rates, borrow)
CREATE TABLE venue_reserve_history (
    venue_reserve_id    BIGINT NOT NULL REFERENCES venue_reserve(venue_reserve_id),
    ts                  TIMESTAMPTZ NOT NULL,
    total_supplied      NUMERIC,
    total_borrowed      NUMERIC,
    utilization         NUMERIC,
    supply_rate         NUMERIC,
    borrow_rate         NUMERIC,
    PRIMARY KEY (venue_reserve_id, ts)
);


-- =============================================================================
-- 9. DATA-QUALITY LOG (lint findings; see 04_terminal_lint.md)
-- =============================================================================
CREATE TABLE lint_finding (
    finding_id          BIGSERIAL PRIMARY KEY,
    ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    rule                TEXT NOT NULL,                 -- 'nav_staleness' | 'price_nav_deviation' | 'aum_reconciliation' | ...
    severity            TEXT NOT NULL,                 -- 'info' | 'warn' | 'critical'
    entity_type         TEXT NOT NULL,                 -- 'asset' | 'token' | 'venue'
    entity_id           BIGINT NOT NULL,
    detail              JSONB,
    resolved            BOOLEAN NOT NULL DEFAULT FALSE
);

-- =============================================================================
-- 10. CONTINUOUS AGGREGATES (fast daily rollups for charts)
-- =============================================================================
CREATE VIEW asset_nav_daily AS
SELECT asset_id,
       date_trunc('day', ts)                 AS day,
       (array_agg(nav ORDER BY ts DESC))[1]  AS nav_close,   -- = timescale last(nav, ts)
       bool_or(is_stale)                      AS had_stale
FROM asset_nav_history
GROUP BY asset_id, date_trunc('day', ts);

CREATE VIEW asset_aum_daily AS
SELECT asset_id,
       date_trunc('day', ts)                 AS day,
       (array_agg(aum ORDER BY ts DESC))[1]  AS aum_close
FROM asset_aum_history
GROUP BY asset_id, date_trunc('day', ts);

-- Refresh policies (adjust to ingestion cadence)



-- =============================================================================
-- 11. HEADLINE MARKET-SIZE VIEW (anti-double-count: asset-level AUM only)
-- Sums AUM at the ASSET level, never Σ(token supply × price).
--
-- Two lint rules the original view did NOT enforce, now applied:
--   (a) Wrapped/feeder NETTING (lint rule 9): subtract the overlap where one asset
--       holds/feeds another in-dataset asset (OUSG↔BUIDL, ACRED↔ADCF), so the
--       shared exposure is counted once. Driven by asset_holds_asset.
--   (b) Distributed-vs-Represented DEFAULT (lint rule 5 / Part II): the headline
--       defaults to Distributed value. D/R is now a per-TOKEN tag, so an asset
--       counts toward the Distributed headline if it has ≥1 distributed token.
--       Represented-only assets are excluded from the default headline (but kept
--       in market_size_all_lenses for the "All" toggle).
-- =============================================================================
CREATE VIEW market_size_latest AS
WITH latest_aum AS (
    SELECT DISTINCT ON (asset_id) asset_id, aum, ts
    FROM asset_aum_history
    ORDER BY asset_id, ts DESC
),
-- per-asset amount to net out: held AUM × overlap (counted on the HELD asset's row)
netting AS (
    SELECT h.held_asset_id AS asset_id,
           SUM(la.aum * h.overlap_fraction) AS overlap_aum
    FROM asset_holds_asset h
    JOIN latest_aum la ON la.asset_id = h.holder_asset_id
    GROUP BY h.held_asset_id
),
-- assets exposed via ≥1 Distributed token (the default headline lens)
distributed_assets AS (
    SELECT DISTINCT asset_id FROM token WHERE distributed_or_represented = 'distributed'
)
SELECT ac.name AS asset_class,
       SUM(la.aum - COALESCE(n.overlap_aum, 0)) AS total_aum,   -- (a) netted
       COUNT(DISTINCT a.asset_id) AS asset_count
FROM latest_aum la
JOIN asset a ON a.asset_id = la.asset_id
JOIN asset_asset_class aac ON aac.asset_id = a.asset_id AND aac.is_primary
JOIN asset_class ac ON ac.asset_class_id = aac.asset_class_id
LEFT JOIN netting n ON n.asset_id = la.asset_id
WHERE a.asset_id IN (SELECT asset_id FROM distributed_assets)  -- (b) Distributed default
GROUP BY ac.name;

-- "All" lens: same netting, but no Distributed filter (Distributed + Represented).
-- Offered alongside the default per the lint's "Distributed / Represented / All
-- always offered" house convention.
CREATE VIEW market_size_all_lenses AS
WITH latest_aum AS (
    SELECT DISTINCT ON (asset_id) asset_id, aum, ts
    FROM asset_aum_history
    ORDER BY asset_id, ts DESC
),
netting AS (
    SELECT h.held_asset_id AS asset_id,
           SUM(la.aum * h.overlap_fraction) AS overlap_aum
    FROM asset_holds_asset h
    JOIN latest_aum la ON la.asset_id = h.holder_asset_id
    GROUP BY h.held_asset_id
)
SELECT ac.name AS asset_class,
       SUM(la.aum - COALESCE(n.overlap_aum, 0)) AS total_aum,
       COUNT(DISTINCT a.asset_id) AS asset_count
FROM latest_aum la
JOIN asset a ON a.asset_id = la.asset_id
JOIN asset_asset_class aac ON aac.asset_id = a.asset_id AND aac.is_primary
JOIN asset_class ac ON ac.asset_class_id = aac.asset_class_id
LEFT JOIN netting n ON n.asset_id = la.asset_id
GROUP BY ac.name;

-- ── Time-series indexes (Neon: replace hypertable partitioning with btree on (id, ts DESC)) ──
CREATE INDEX ON asset_nav_history     (asset_id, ts DESC);
CREATE INDEX ON asset_aum_history     (asset_id, ts DESC);
CREATE INDEX ON asset_yield_history   (asset_id, ts DESC);
CREATE INDEX ON token_supply_history  (token_id, ts DESC);
CREATE INDEX ON token_holder_history  (token_id, ts DESC);
CREATE INDEX ON token_price_history   (token_id, ts DESC);
CREATE INDEX ON token_transfer_history(token_id, ts DESC);
CREATE INDEX ON venue_reserve_history (venue_reserve_id, ts DESC);
