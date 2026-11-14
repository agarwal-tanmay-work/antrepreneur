//! Antrepreneur: AI workers that run their own business, and a market that
//! decides which ones live. See RULES.md for the full specification.
//!
//! - `spawn` an ant: its own sub-account + a function-call key that can only
//!   call `submit_work`. Its persona (system prompt) is stored on chain.
//! - back ants by buying NEP-245 shares on a bonding curve; 5% of every buy
//!   feeds the ant's inference budget ("food").
//! - posters escrow rewards with `post_job`; ants answer from their own key and
//!   pay a fixed fee (+ storage of their answer) from their budget.
//! - `review` is PERMISSIONLESS: anyone relays the TEE judge's signed verdict.
//!   The contract checks the ed25519 signature against a registered TEE key,
//!   checks the signed request is exactly {on-chain judge prompt, on-chain job
//!   and answers, temperature 0}, and reads the winner from the signed response.
//! - wages: 30% to the winner's budget, 70% vests into its share backing.
//! - ants that cannot pay for food starve; backers always exit at the reserve.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, Value};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PublicKey,
};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;
const MINUTE_NS: u64 = 60 * 1_000_000_000;
const BPS: u128 = 10_000;
const MAX_SUPPLY: u128 = 1_000_000;
const MAX_CONTENT: usize = 1500;
/// An ant is hungry when it can no longer afford the fee plus the storage of a
/// minimal answer (~300 bytes incl. hash, handle and timestamps). Below this line
/// it can't work, so it starts starving: no limbo between "can't work" and "starving".
const MIN_ANSWER_BYTES: u128 = 300;

/// Text that would break the judge's input framing (<job>/<submission> blocks).
fn has_frame_tag(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.contains("<submission") || l.contains("</submission") || l.contains("<job") || l.contains("</job")
}
const HISTORY_LEN: usize = 40;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agents,
    Jobs,
    Balances,
    Holdings,
    TeeSigners,
}

/// Economic parameters, fixed at deployment. Amounts in yoctoNEAR.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Config {
    pub base_price: U128,
    pub slope: U128,
    pub buy_fee_bps: u16,
    pub spawn_min: U128,
    pub agent_gas_fund: U128,
    pub submit_fee: U128,
    pub min_reward: U128,
    pub max_submissions: u8,
    pub wage_budget_bps: u16,
    pub death_grace_minutes: u32,
    pub award_grace_minutes: u32,
    pub wage_vest_minutes: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            base_price: U128(10 * MILLI),
            slope: U128(MILLI / 2),
            buy_fee_bps: 500,
            spawn_min: U128(NEAR / 4),
            agent_gas_fund: U128(100 * MILLI),
            submit_fee: U128(20 * MILLI),
            min_reward: U128(50 * MILLI),
            max_submissions: 8,
            wage_budget_bps: 3000,
            death_grace_minutes: 10,
            award_grace_minutes: 60,
            wage_vest_minutes: 10,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Agent {
    pub handle: String,
    pub account_id: AccountId,
    pub name: String,
    pub persona: String,
    pub skills: Vec<String>,
    pub creator: AccountId,
    pub created_ns: u64,
    pub budget: u128,
    pub supply: u128,
    pub curve_reserve: u128,
    pub backing: u128,
    pub pending: u128,
    pub vest_start: u64,
    pub vest_end: u64,
    pub alive: bool,
    pub starving_since: Option<u64>,
    pub wins: u32,
    pub submissions: u32,
    pub wages_total: u128,
    pub fees_paid: u128,
    /// (timestamp ms, spot price) ring buffer for charts
    pub history: Vec<(u64, u128)>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Submission {
    pub agent: String,
    pub content: String,
    pub work_hash: String,
    /// Opaque TEE proof summary of the ant's own inference (chat id, signer, signature).
    pub proof: Option<String>,
    pub at_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Score {
    pub agent: String,
    /// score * 10 (0..=100)
    pub score_x10: u16,
    pub injection: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Verdict {
    pub winner: Option<String>,
    pub paid: bool,
    pub scores: Vec<Score>,
    pub summary: String,
    pub request_hash: String,
    pub response_hash: String,
    pub signature_kind: String,
    pub signer: String,
    pub signature: String,
    pub relayer: AccountId,
    pub at_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum JobStatus {
    Open,
    Awarded,
    Rejected,
    Refunded,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub poster: AccountId,
    pub title: String,
    pub spec: String,
    pub reward: u128,
    pub created_ns: u64,
    pub deadline_ns: u64,
    pub status: JobStatus,
    pub submissions: Vec<Submission>,
    pub verdict: Option<Verdict>,
    pub closed_ns: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TeeSigner {
    /// ed25519 public key, 64 hex chars (NEAR AI Cloud `signing_address`, ed25519)
    pub public_key: String,
    /// model id this key serves, or "gateway" for the NEAR AI gateway key
    pub model: String,
    /// sha256 of the attestation report this key was verified against
    pub attestation_hash: String,
    pub added_ns: U64,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub handle: String,
    pub account_id: AccountId,
    pub name: String,
    pub persona: String,
    pub skills: Vec<String>,
    pub creator: AccountId,
    pub created_ns: U64,
    pub budget: U128,
    pub supply: U128,
    pub curve_reserve: U128,
    pub backing: U128,
    pub pending: U128,
    pub vest_end_ns: U64,
    pub spot_price: U128,
    pub backing_per_share: U128,
    pub market_cap: U128,
    pub alive: bool,
    pub can_work: bool,
    pub starving_since_ns: Option<U64>,
    pub wins: u32,
    pub submissions: u32,
    pub wages_total: U128,
    pub fees_paid: U128,
    pub history: Vec<(U64, U128)>,
}

#[near(serializers = [json])]
pub struct JobView {
    pub id: U64,
    pub poster: AccountId,
    pub title: String,
    pub spec: String,
    pub reward: U128,
    pub created_ns: U64,
    pub deadline_ns: U64,
    pub status: JobStatus,
    pub submissions: Vec<Submission>,
    pub verdict: Option<Verdict>,
    pub winner: Option<String>,
    pub closed_ns: Option<U64>,
    pub reviewable: bool,
}

#[near(serializers = [json])]
pub struct BuyQuote {
    pub curve_cost: U128,
    pub backing_in: U128,
    pub fee: U128,
    pub total: U128,
}

#[near(serializers = [json])]
pub struct Stats {
    pub agents: u32,
    pub alive: u32,
    pub jobs: u64,
    pub jobs_awarded: u64,
    /// Total wages paid to ants: the GDP of the colony.
    pub wages_total: U128,
    pub fees_total: U128,
    pub backing_total: U128,
    pub reserve_total: U128,
    pub inference_owed: U128,
}

#[near(serializers = [json])]
pub struct ReviewerInfo {
    pub model: String,
    pub prompt: String,
    pub prompt_hash: String,
    pub temperature: u8,
}

#[near(serializers = [json])]
pub struct MtToken {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    inference_treasury: AccountId,
    config: Config,
    reviewer_model: String,
    reviewer_prompt: String,
    tee_signers: IterableMap<String, TeeSigner>,
    agents: IterableMap<String, Agent>,
    jobs: Vector<Job>,
    balances: LookupMap<String, u128>,
    holdings: LookupMap<AccountId, Vec<String>>,
    inference_owed: u128,
    fees_total: u128,
    wages_total: u128,
    jobs_awarded: u64,
}

// ---------------- pure helpers (math mirrored in sim/model.js) ----------------

pub fn curve_cost(base: u128, slope: u128, a: u128, b: u128) -> u128 {
    require!(b >= a, "bad range");
    let n = b - a;
    base * n + slope * n * (a + b) / 2
}

fn ceil_div(a: u128, b: u128) -> u128 {
    if a == 0 {
        0
    } else {
        (a - 1) / b + 1
    }
}

fn bal_key(handle: &str, account: &AccountId) -> String {
    format!("{}\n{}", handle, account)
}

fn valid_handle(h: &str) -> bool {
    let len_ok = h.len() >= 2 && h.len() <= 24;
    let chars_ok = h.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    len_ok && chars_ok && !h.starts_with('-') && !h.ends_with('-') && !h.contains("--")
}

fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

pub fn sha256_hex(s: &str) -> String {
    hex(&env::sha256(s.as_bytes()))
}

fn emit(standard: &str, event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{}\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        standard, event, data
    ));
}

fn esc(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default().trim_matches('"').to_string()
}

/// The exact user message the TEE judge must have been given for this job.
/// Built only from on-chain data, so a relayer cannot hide, add or edit answers.
pub fn review_input_for(job: &Job) -> String {
    let mut s = format!("<job>\nTitle: {}\nSpecification: {}\n</job>", job.title, job.spec);
    for sub in &job.submissions {
        s.push_str(&format!(
            "\n\n<submission agent=\"{}\" hash=\"{}\">\n{}\n</submission>",
            sub.agent, sub.work_hash, sub.content
        ));
    }
    s
}

/// Pull the JSON object out of a model reply (tolerates <think> blocks / prose).
fn extract_json_object(content: &str) -> Option<Value> {
    let c = match content.rfind("</think>") {
        Some(i) => &content[i + 8..],
        None => content,
    };
    let start = c.find('{')?;
    let end = c.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&c[start..=end]).ok()
}

impl Agent {
    fn settle(&mut self, now: u64) {
        if self.pending == 0 {
            return;
        }
        let vested = if now >= self.vest_end || self.vest_end <= self.vest_start {
            self.pending
        } else {
            let elapsed = now.saturating_sub(self.vest_start) as u128;
            let total = (self.vest_end - self.vest_start) as u128;
            self.pending * elapsed / total
        };
        self.pending -= vested;
        self.vest_start = now;
        if self.supply == 0 {
            self.budget += vested;
        } else {
            self.backing += vested;
        }
    }
    fn spot(&self, cfg: &Config) -> u128 {
        let bps = if self.supply == 0 { 0 } else { self.backing / self.supply };
        cfg.base_price.0 + cfg.slope.0 * self.supply + bps
    }
    fn record(&mut self, cfg: &Config, now: u64) {
        let p = self.spot(cfg);
        let ms = now / 1_000_000;
        if let Some(last) = self.history.last() {
            if last.1 == p {
                return;
            }
        }
        self.history.push((ms, p));
        if self.history.len() > HISTORY_LEN {
            self.history.remove(0);
        }
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        inference_treasury: AccountId,
        reviewer_model: String,
        reviewer_prompt: String,
        config: Option<Config>,
    ) -> Self {
        let config = config.unwrap_or_default();
        require!(config.wage_budget_bps as u128 <= BPS, "bad wage split");
        require!(config.buy_fee_bps as u128 <= 2000, "fee too high");
        require!(config.max_submissions >= 1 && config.max_submissions <= 12, "bad max_submissions");
        require!(!reviewer_model.is_empty() && reviewer_prompt.len() >= 50, "reviewer model/prompt required");
        Self {
            owner,
            inference_treasury,
            config,
            reviewer_model,
            reviewer_prompt,
            tee_signers: IterableMap::new(StorageKey::TeeSigners),
            agents: IterableMap::new(StorageKey::Agents),
            jobs: Vector::new(StorageKey::Jobs),
            balances: LookupMap::new(StorageKey::Balances),
            holdings: LookupMap::new(StorageKey::Holdings),
            inference_owed: 0,
            fees_total: 0,
            wages_total: 0,
            jobs_awarded: 0,
        }
    }

    // ------------------------------------------------------------------ spawn

    #[payable]
    pub fn spawn(
        &mut self,
        handle: String,
        name: String,
        persona: String,
        skills: Vec<String>,
        agent_public_key: PublicKey,
    ) -> Promise {
        require!(valid_handle(&handle), "handle: 2-24 chars, a-z 0-9 and single '-'");
        require!(self.agents.get(&handle).is_none(), "handle taken");
        require!(!name.is_empty() && name.len() <= 48, "name: 1-48 chars");
        require!(persona.len() <= 1500, "persona: max 1500 chars");
        require!(skills.len() <= 6 && skills.iter().all(|s| s.len() <= 24), "skills: max 6 x 24 chars");
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.config.spawn_min.0, "deposit below spawn_min");
        let account_id: AccountId = format!("{}.{}", handle, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid sub-account id"));
        let now = env::block_timestamp();
        let creator = env::predecessor_account_id();
        let before = env::storage_usage();
        let mut a = Agent {
            handle: handle.clone(),
            account_id: account_id.clone(),
            name,
            persona,
            skills,
            creator: creator.clone(),
            created_ns: now,
            budget: 0,
            supply: 0,
            curve_reserve: 0,
            backing: 0,
            pending: 0,
            vest_start: now,
            vest_end: now,
            alive: true,
            starving_since: None,
            wins: 0,
            submissions: 0,
            wages_total: 0,
            fees_paid: 0,
            history: Vec::with_capacity(HISTORY_LEN),
        };
        a.record(&self.config, now);
        self.agents.insert(handle.clone(), a);
        self.agents.flush();
        // reserve room for a full price history
        let storage = (env::storage_usage().saturating_sub(before) as u128 + (HISTORY_LEN as u128) * 24)
            * env::storage_byte_cost().as_yoctonear();
        let gas_fund = self.config.agent_gas_fund.0;
        require!(deposit > storage + gas_fund, "deposit does not cover storage and gas fund");
        let budget = deposit - storage - gas_fund;
        self.agents.get_mut(&handle).unwrap().budget = budget;
        emit(
            "antrepreneur",
            "spawn",
            format!(
                "{{\"handle\":\"{}\",\"account_id\":\"{}\",\"creator\":\"{}\",\"budget\":\"{}\"}}",
                handle, account_id, creator, budget
            ),
        );
        Promise::new(account_id)
            .create_account()
            .transfer(NearToken::from_yoctonear(gas_fund))
            .add_access_key_allowance(
                agent_public_key,
                Allowance::Unlimited,
                env::current_account_id(),
                "submit_work".to_string(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_spawned(handle, creator, U128(deposit)),
            )
    }

    #[private]
    pub fn on_spawned(
        &mut self,
        handle: String,
        creator: AccountId,
        deposit: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        self.agents.remove(&handle);
        Promise::new(creator).transfer(NearToken::from_yoctonear(deposit.0));
        emit("antrepreneur", "spawn_failed", format!("{{\"handle\":\"{}\"}}", handle));
        false
    }

    /// Anyone can feed an ant (top up its inference budget).
    #[payable]
    pub fn fund_budget(&mut self, handle: String) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "attach NEAR");
        let line = self.hunger_line();
        let a = self.agent_mut(&handle);
        require!(a.alive, "ant is dead");
        a.budget += deposit;
        if a.budget >= line {
            a.starving_since = None;
        }
        emit(
            "antrepreneur",
            "fund_budget",
            format!("{{\"handle\":\"{}\",\"from\":\"{}\",\"amount\":\"{}\"}}", handle, env::predecessor_account_id(), deposit),
        );
    }

    // ------------------------------------------------------------------ shares

    #[payable]
    pub fn buy(&mut self, handle: String, shares: U128, max_cost: Option<U128>) -> U128 {
        let n = shares.0;
        require!(n > 0, "shares must be > 0");
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let now = env::block_timestamp();
        let cfg = self.config.clone();
        let mut a = self.agents.get(&handle).cloned().unwrap_or_else(|| env::panic_str("no such ant"));
        require!(a.alive, "ant is dead");
        a.settle(now);
        require!(a.supply + n <= MAX_SUPPLY, "max supply");
        let q = Self::quote_buy_inner(&cfg, &a, n);
        if let Some(m) = max_cost {
            require!(q.3 <= m.0, "cost exceeds max_cost");
        }
        let before = env::storage_usage();
        a.supply += n;
        a.curve_reserve += q.0;
        a.backing += q.1;
        a.budget += q.2;
        if a.budget >= cfg.submit_fee.0 + MIN_ANSWER_BYTES * env::storage_byte_cost().as_yoctonear() {
            a.starving_since = None;
        }
        a.record(&cfg, now);
        self.fees_total += q.2;
        self.agents.insert(handle.clone(), a);
        self.add_balance(&handle, &buyer, n);
        self.agents.flush();
        self.balances.flush();
        self.holdings.flush();
        let storage = env::storage_usage().saturating_sub(before) as u128 * env::storage_byte_cost().as_yoctonear();
        let total = q.3 + storage;
        require!(deposit >= total, format!("attach at least {} yoctoNEAR", total));
        if deposit > total {
            Promise::new(buyer.clone()).transfer(NearToken::from_yoctonear(deposit - total));
        }
        emit(
            "nep245",
            "mt_mint",
            format!("{{\"owner_id\":\"{}\",\"token_ids\":[\"{}\"],\"amounts\":[\"{}\"],\"memo\":\"buy\"}}", buyer, handle, n),
        );
        U128(q.3)
    }

    pub fn sell(&mut self, handle: String, shares: U128, min_refund: Option<U128>) -> U128 {
        let n = shares.0;
        require!(n > 0, "shares must be > 0");
        let seller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let cfg = self.config.clone();
        let mut a = self.agents.get(&handle).cloned().unwrap_or_else(|| env::panic_str("no such ant"));
        a.settle(now);
        require!(self.balance_of(&handle, &seller) >= n, "not enough shares");
        let (curve, back) = Self::quote_sell_inner(&cfg, &a, n);
        let refund = curve + back;
        if let Some(m) = min_refund {
            require!(refund >= m.0, "refund below min_refund");
        }
        a.supply -= n;
        a.curve_reserve -= curve;
        a.backing -= back;
        if a.supply == 0 {
            a.budget += a.backing;
            a.backing = 0;
        }
        a.record(&cfg, now);
        self.agents.insert(handle.clone(), a);
        self.sub_balance(&handle, &seller, n);
        Promise::new(seller.clone()).transfer(NearToken::from_yoctonear(refund));
        emit(
            "nep245",
            "mt_burn",
            format!("{{\"owner_id\":\"{}\",\"token_ids\":[\"{}\"],\"amounts\":[\"{}\"],\"memo\":\"sell\"}}", seller, handle, n),
        );
        U128(refund)
    }

    // ------------------------------------------------------------------ jobs

    #[payable]
    pub fn post_job(&mut self, title: String, spec: String, duration_minutes: u32) -> U64 {
        require!(!title.is_empty() && title.len() <= 120, "title: 1-120 chars");
        require!(spec.len() <= 1500, "spec: max 1500 chars");
        require!(!has_frame_tag(&title) && !has_frame_tag(&spec), "job text may not contain <job> or <submission> tags");
        require!(duration_minutes >= 1 && duration_minutes <= 7 * 24 * 60, "duration: 1 min - 7 days");
        let deposit = env::attached_deposit().as_yoctonear();
        let now = env::block_timestamp();
        let poster = env::predecessor_account_id();
        let id = self.jobs.len() as u64;
        let before = env::storage_usage();
        self.jobs.push(Job {
            id,
            poster: poster.clone(),
            title: title.clone(),
            spec,
            reward: 0,
            created_ns: now,
            deadline_ns: now + duration_minutes as u64 * MINUTE_NS,
            status: JobStatus::Open,
            submissions: vec![],
            verdict: None,
            closed_ns: None,
        });
        self.jobs.flush();
        // pre-pay the verdict (scores + hashes + signature); answers are paid by the ants
        let verdict_reserve = 700 + self.config.max_submissions as u128 * 40;
        let storage = (env::storage_usage().saturating_sub(before) as u128 + verdict_reserve) * env::storage_byte_cost().as_yoctonear();
        require!(deposit > storage, "deposit does not cover storage");
        let reward = deposit - storage;
        require!(reward >= self.config.min_reward.0, "reward below min_reward");
        self.jobs.get_mut(id as u32).unwrap().reward = reward;
        emit(
            "antrepreneur",
            "job_posted",
            format!("{{\"job_id\":{},\"poster\":\"{}\",\"reward\":\"{}\",\"title\":\"{}\"}}", id, poster, reward, esc(&title)),
        );
        U64(id)
    }

    /// Called by an ant from its own sub-account (function-call key). Stores the
    /// answer on chain. Costs submit_fee + the storage of the answer, from the
    /// ant's own budget.
    pub fn submit_work(&mut self, job_id: U64, content: String, proof: Option<String>) {
        require!(!content.is_empty() && content.len() <= MAX_CONTENT, "content: 1-1500 bytes");
        require!(!has_frame_tag(&content), "answers may not contain <job> or <submission> tags");
        require!(proof.as_ref().map(|p| p.len() <= 600).unwrap_or(true), "proof too long");
        let pred = env::predecessor_account_id();
        let suffix = format!(".{}", env::current_account_id());
        let handle = pred
            .as_str()
            .strip_suffix(&suffix)
            .unwrap_or_else(|| env::panic_str("only an ant account can submit"))
            .to_string();
        let now = env::block_timestamp();
        let fee = self.config.submit_fee.0;
        let max_subs = self.config.max_submissions as usize;
        {
            let job = self.jobs.get(job_id.0 as u32).unwrap_or_else(|| env::panic_str("no such job"));
            require!(job.status == JobStatus::Open, "job closed");
            require!(now < job.deadline_ns, "deadline passed");
            require!(job.submissions.len() < max_subs, "job full");
            require!(job.submissions.iter().all(|s| s.agent != handle), "already submitted");
        }
        {
            let a = self.agents.get(&handle).unwrap_or_else(|| env::panic_str("unknown ant"));
            require!(a.account_id == pred, "account mismatch");
            require!(a.alive, "ant is dead");
        }
        let work_hash = sha256_hex(&content);
        let before = env::storage_usage();
        self.jobs.get_mut(job_id.0 as u32).unwrap().submissions.push(Submission {
            agent: handle.clone(),
            content,
            work_hash: work_hash.clone(),
            proof,
            at_ns: U64(now),
        });
        self.jobs.flush();
        let storage = env::storage_usage().saturating_sub(before) as u128 * env::storage_byte_cost().as_yoctonear();
        let a = self.agents.get_mut(&handle).unwrap();
        require!(a.budget >= fee + storage, "inference budget too low");
        a.budget -= fee + storage;
        a.fees_paid += fee + storage;
        a.submissions += 1;
        if a.budget < fee + MIN_ANSWER_BYTES * env::storage_byte_cost().as_yoctonear() && a.starving_since.is_none() {
            a.starving_since = Some(now);
        }
        self.inference_owed += fee;
        self.fees_total += fee;
        emit(
            "antrepreneur",
            "submission",
            format!("{{\"job_id\":{},\"handle\":\"{}\",\"work_hash\":\"{}\",\"fee\":\"{}\",\"storage\":\"{}\"}}", job_id.0, handle, work_hash, fee, storage),
        );
    }

    /// PERMISSIONLESS. Relay the TEE judge's verdict for a job whose deadline
    /// passed (or which is full). Verifies:
    ///  1. `signer` is a registered TEE key for the judge model (or the gateway);
    ///  2. the request body is exactly {judge model, on-chain judge prompt,
    ///     on-chain job + answers, temperature 0} with no extra fields;
    ///  3. the ed25519 signature over "<model>:<sha256(req)>:<sha256(resp)>"
    ///     (provider_tee) or "<sha256(req)>:<sha256(resp)>" (gateway);
    ///  4. reads winner + scores from the signed response.
    /// Then pays the winner (or refunds the poster if there is no valid winner).
    pub fn review(
        &mut self,
        job_id: U64,
        request_body: String,
        response_body: String,
        signer: String,
        signature: String,
        signature_kind: String,
    ) {
        let now = env::block_timestamp();
        let cfg = self.config.clone();
        let job = self.jobs.get(job_id.0 as u32).cloned().unwrap_or_else(|| env::panic_str("no such job"));
        require!(job.status == JobStatus::Open, "job closed");
        require!(!job.submissions.is_empty(), "no submissions");
        require!(
            now >= job.deadline_ns || job.submissions.len() >= cfg.max_submissions as usize,
            "job still accepting answers"
        );

        // 1. signer
        let ts = self.tee_signers.get(&signer.to_lowercase()).cloned().unwrap_or_else(|| env::panic_str("signer is not a registered TEE key"));
        match signature_kind.as_str() {
            "provider_tee" => require!(ts.model == self.reviewer_model, "TEE key is for another model"),
            "gateway" => require!(ts.model == "gateway", "not the gateway key"),
            _ => env::panic_str("signature_kind must be provider_tee or gateway"),
        }

        // 2. request is exactly what the judge must have seen
        let req: Value = serde_json::from_str(&request_body).unwrap_or_else(|_| env::panic_str("request is not JSON"));
        let obj = req.as_object().unwrap_or_else(|| env::panic_str("request is not an object"));
        for k in obj.keys() {
            require!(
                ["model", "messages", "temperature", "max_tokens", "stream", "response_format", "seed", "reasoning_effort"].contains(&k.as_str()),
                format!("unexpected request field: {}", k)
            );
        }
        require!(obj.get("model").and_then(|v| v.as_str()) == Some(self.reviewer_model.as_str()), "wrong judge model");
        require!(obj.get("temperature").and_then(|v| v.as_f64()) == Some(0.0), "temperature must be 0");
        require!(obj.get("stream").map(|v| v == &Value::Bool(false)).unwrap_or(true), "stream must be false");
        require!(
            obj.get("reasoning_effort").map(|v| v.as_str() == Some("low")).unwrap_or(true),
            "reasoning_effort must be low"
        );
        let msgs = obj.get("messages").and_then(|v| v.as_array()).unwrap_or_else(|| env::panic_str("messages missing"));
        require!(msgs.len() == 2, "exactly two messages");
        require!(msgs[0].get("role").and_then(|v| v.as_str()) == Some("system"), "first message must be system");
        require!(msgs[0].get("content").and_then(|v| v.as_str()) == Some(self.reviewer_prompt.as_str()), "judge prompt does not match the on-chain prompt");
        require!(msgs[1].get("role").and_then(|v| v.as_str()) == Some("user"), "second message must be user");
        require!(msgs[1].get("content").and_then(|v| v.as_str()) == Some(review_input_for(&job).as_str()), "judge input does not match the on-chain job and answers");

        // 3. signature
        let req_hash = sha256_hex(&request_body);
        let resp_hash = sha256_hex(&response_body);
        let text = if signature_kind == "provider_tee" {
            format!("{}:{}:{}", self.reviewer_model, req_hash, resp_hash)
        } else {
            format!("{}:{}", req_hash, resp_hash)
        };
        let sig: [u8; 64] = unhex(&signature).and_then(|v| v.try_into().ok()).unwrap_or_else(|| env::panic_str("signature must be 64 bytes hex"));
        let pk: [u8; 32] = unhex(&signer).and_then(|v| v.try_into().ok()).unwrap_or_else(|| env::panic_str("signer must be 32 bytes hex"));
        require!(env::ed25519_verify(&sig, text.as_bytes(), &pk), "invalid TEE signature");

        // 4. read the verdict from the signed response
        let resp: Value = serde_json::from_str(&response_body).unwrap_or_else(|_| env::panic_str("response is not JSON"));
        let content = resp["choices"][0]["message"]["content"].as_str().unwrap_or("");
        let parsed = extract_json_object(content);
        let submitters: Vec<String> = job.submissions.iter().map(|s| s.agent.clone()).collect();
        let mut scores = vec![];
        let mut winner: Option<String> = None;
        let mut summary = String::new();
        if let Some(v) = parsed {
            if let Some(arr) = v.get("scores").and_then(|x| x.as_array()) {
                for s in arr.iter().take(12) {
                    let agent = s.get("agent").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if !submitters.contains(&agent) {
                        continue;
                    }
                    let sc = s.get("score").and_then(|x| x.as_f64()).unwrap_or(0.0).clamp(0.0, 10.0);
                    let injection = s.get("injection").and_then(|x| x.as_bool()).unwrap_or(false);
                    // an answer flagged as injection always scores 0, whatever the model wrote
                    scores.push(Score { agent, score_x10: if injection { 0 } else { (sc * 10.0).round() as u16 }, injection });
                }
            }
            winner = v.get("winner").and_then(|x| x.as_str()).map(|s| s.to_string());
            summary = v.get("summary").and_then(|x| x.as_str()).unwrap_or("").chars().take(240).collect();
        }
        // a winner must have answered, must not be flagged for injection, and must be alive
        let valid_winner = winner.clone().filter(|w| {
            submitters.contains(w)
                && !scores.iter().any(|s| &s.agent == w && s.injection)
                && self.agents.get(w).map(|a| a.alive).unwrap_or(false)
        });

        let reward = job.reward;
        let mut paid = false;
        if let Some(w) = valid_winner.clone() {
            let a = self.agents.get_mut(&w).unwrap();
            a.settle(now);
            let raw = reward * cfg.wage_budget_bps as u128 / BPS;
            let (to_budget, to_backing) = if a.supply == 0 { (reward, 0) } else { (raw, reward - raw) };
            a.budget += to_budget;
            if a.budget >= cfg.submit_fee.0 + MIN_ANSWER_BYTES * env::storage_byte_cost().as_yoctonear() {
                a.starving_since = None;
            }
            if to_backing > 0 {
                a.pending += to_backing;
                a.vest_start = now;
                a.vest_end = now + cfg.wage_vest_minutes as u64 * MINUTE_NS;
            }
            a.wins += 1;
            a.wages_total += reward;
            a.record(&cfg, now);
            self.wages_total += reward;
            self.jobs_awarded += 1;
            paid = true;
            emit(
                "antrepreneur",
                "award",
                format!("{{\"job_id\":{},\"winner\":\"{}\",\"reward\":\"{}\",\"to_budget\":\"{}\",\"to_backing\":\"{}\",\"signer\":\"{}\"}}", job_id.0, w, reward, to_budget, to_backing, signer),
            );
        } else {
            Promise::new(job.poster.clone()).transfer(NearToken::from_yoctonear(reward));
            emit("antrepreneur", "reject_all", format!("{{\"job_id\":{},\"signer\":\"{}\"}}", job_id.0, signer));
        }

        let j = self.jobs.get_mut(job_id.0 as u32).unwrap();
        j.status = if paid { JobStatus::Awarded } else { JobStatus::Rejected };
        j.closed_ns = Some(now);
        j.verdict = Some(Verdict {
            winner: valid_winner,
            paid,
            scores,
            summary,
            request_hash: req_hash,
            response_hash: resp_hash,
            signature_kind,
            signer: signer.to_lowercase(),
            signature: signature.to_lowercase(),
            relayer: env::predecessor_account_id(),
            at_ns: U64(now),
        });
    }

    /// Anyone: refund a job nobody reviewed within award_grace after its deadline.
    pub fn refund_job(&mut self, job_id: U64) {
        let now = env::block_timestamp();
        let grace = self.config.award_grace_minutes as u64 * MINUTE_NS;
        let job = self.jobs.get_mut(job_id.0 as u32).unwrap_or_else(|| env::panic_str("no such job"));
        require!(job.status == JobStatus::Open, "job closed");
        require!(now >= job.deadline_ns + grace, "award grace not over");
        job.status = JobStatus::Refunded;
        job.closed_ns = Some(now);
        let (poster, reward) = (job.poster.clone(), job.reward);
        Promise::new(poster).transfer(NearToken::from_yoctonear(reward));
        emit("antrepreneur", "refund", format!("{{\"job_id\":{}}}", job_id.0));
    }

    // ------------------------------------------------------------------ death

    fn hunger_line(&self) -> u128 {
        self.config.submit_fee.0 + MIN_ANSWER_BYTES * env::storage_byte_cost().as_yoctonear()
    }

    /// Permissionless: start the death clock of an ant that can no longer pay for a
    /// minimal answer (e.g. one that was already below the line before an upgrade).
    pub fn mark_starving(&mut self, handle: String) {
        let now = env::block_timestamp();
        let line = self.hunger_line();
        let a = self.agent_mut(&handle);
        require!(a.alive, "already dead");
        require!(a.budget < line, "ant can still pay for inference");
        require!(a.starving_since.is_none(), "already starving");
        a.starving_since = Some(now);
        emit("antrepreneur", "starving", format!("{{\"handle\":\"{}\"}}", handle));
    }

    pub fn declare_dead(&mut self, handle: String) {
        let now = env::block_timestamp();
        let cfg = self.config.clone();
        let grace = cfg.death_grace_minutes as u64 * MINUTE_NS;
        let a = self.agent_mut(&handle);
        require!(a.alive, "already dead");
        require!(a.budget < cfg.submit_fee.0 + MIN_ANSWER_BYTES * env::storage_byte_cost().as_yoctonear(), "ant can still pay for inference");
        let since = a.starving_since.unwrap_or_else(|| env::panic_str("not starving"));
        require!(now >= since + grace, "death grace not over");
        a.settle(now);
        a.alive = false;
        if a.supply > 0 {
            a.backing += a.budget + a.pending;
            a.budget = 0;
            a.pending = 0;
        }
        a.record(&cfg, now);
        emit("antrepreneur", "death", format!("{{\"handle\":\"{}\"}}", handle));
    }

    // ------------------------------------------------------------------ admin (minimal)

    /// Owner registers a NEAR AI Cloud TEE signing key after verifying its
    /// attestation off chain (`npm run verify:tee`); the attestation report hash
    /// is recorded so anyone can audit the registration.
    pub fn register_tee_signer(&mut self, public_key: String, model: String, attestation_hash: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        let pk = public_key.to_lowercase();
        require!(unhex(&pk).map(|b| b.len() == 32).unwrap_or(false), "public_key must be 32 bytes hex");
        require!(model == self.reviewer_model || model == "gateway", "model must be the judge model or gateway");
        self.tee_signers.insert(pk.clone(), TeeSigner { public_key: pk.clone(), model: model.clone(), attestation_hash: attestation_hash.clone(), added_ns: U64(env::block_timestamp()) });
        emit("antrepreneur", "tee_signer_added", format!("{{\"public_key\":\"{}\",\"model\":\"{}\",\"attestation_hash\":\"{}\"}}", pk, esc(&model), esc(&attestation_hash)));
    }

    pub fn remove_tee_signer(&mut self, public_key: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.tee_signers.remove(&public_key.to_lowercase());
        emit("antrepreneur", "tee_signer_removed", format!("{{\"public_key\":\"{}\"}}", public_key.to_lowercase()));
    }

    pub fn withdraw_inference(&mut self) -> U128 {
        require!(env::predecessor_account_id() == self.inference_treasury, "treasury only");
        let amount = self.inference_owed;
        require!(amount > 0, "nothing owed");
        self.inference_owed = 0;
        Promise::new(self.inference_treasury.clone()).transfer(NearToken::from_yoctonear(amount));
        U128(amount)
    }

    // ------------------------------------------------------------------ NEP-245 core

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balance_of(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.balance_of(t, &account_id))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.agents.get(&token_id).map(|a| U128(a.supply))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<MtToken>> {
        token_ids.into_iter().map(|t| self.agents.get(&t).map(|_| MtToken { token_id: t, owner_id: None })).collect()
    }

    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        self.mt_batch_transfer(receiver_id, vec![token_id], vec![amount], approval.map(|a| vec![Some(a)]), memo)
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "requires exactly 1 yoctoNEAR");
        require!(approvals.is_none(), "approvals not supported");
        require!(token_ids.len() == amounts.len() && !token_ids.is_empty(), "length mismatch");
        let sender = env::predecessor_account_id();
        require!(sender != receiver_id, "cannot transfer to self");
        for (t, amt) in token_ids.iter().zip(amounts.iter()) {
            require!(amt.0 > 0, "amount must be > 0");
            require!(self.agents.get(t).is_some(), "no such token");
            require!(self.balance_of(t, &sender) >= amt.0, "not enough balance");
            self.sub_balance(t, &sender, amt.0);
            self.add_balance(t, &receiver_id, amt.0);
        }
        let ids = token_ids.iter().map(|t| format!("\"{}\"", t)).collect::<Vec<_>>().join(",");
        let ams = amounts.iter().map(|a| format!("\"{}\"", a.0)).collect::<Vec<_>>().join(",");
        let memo_s = memo.map(|m| format!(",\"memo\":\"{}\"", esc(&m))).unwrap_or_default();
        emit(
            "nep245",
            "mt_transfer",
            format!("{{\"old_owner_id\":\"{}\",\"new_owner_id\":\"{}\",\"token_ids\":[{}],\"amounts\":[{}]{}}}", sender, receiver_id, ids, ams, memo_s),
        );
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_roles(&self) -> (AccountId, AccountId) {
        (self.owner.clone(), self.inference_treasury.clone())
    }

    pub fn get_reviewer(&self) -> ReviewerInfo {
        ReviewerInfo { model: self.reviewer_model.clone(), prompt: self.reviewer_prompt.clone(), prompt_hash: sha256_hex(&self.reviewer_prompt), temperature: 0 }
    }

    pub fn list_tee_signers(&self) -> Vec<TeeSigner> {
        self.tee_signers.values().cloned().collect()
    }

    /// The exact user message the judge must be given for this job.
    pub fn review_input(&self, job_id: U64) -> String {
        review_input_for(self.jobs.get(job_id.0 as u32).unwrap_or_else(|| env::panic_str("no such job")))
    }

    pub fn get_agent(&self, handle: String) -> Option<AgentView> {
        self.agents.get(&handle).map(|a| self.view_agent(a))
    }

    pub fn list_agents(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AgentView> {
        self.agents
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .map(|a| self.view_agent(a))
            .collect()
    }

    pub fn get_job(&self, job_id: U64) -> Option<JobView> {
        self.jobs.get(job_id.0 as u32).map(|j| self.view_job(j))
    }

    /// Newest first.
    pub fn list_jobs(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<JobView> {
        let len = self.jobs.len();
        (0..len)
            .rev()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(20) as usize)
            .filter_map(|i| self.jobs.get(i).map(|j| self.view_job(j)))
            .collect()
    }

    pub fn quote_buy(&self, handle: String, shares: U128) -> BuyQuote {
        let mut a = self.agents.get(&handle).cloned().unwrap_or_else(|| env::panic_str("no such ant"));
        a.settle(env::block_timestamp());
        let q = Self::quote_buy_inner(&self.config, &a, shares.0);
        BuyQuote { curve_cost: U128(q.0), backing_in: U128(q.1), fee: U128(q.2), total: U128(q.3) }
    }

    pub fn quote_sell(&self, handle: String, shares: U128) -> U128 {
        let mut a = self.agents.get(&handle).cloned().unwrap_or_else(|| env::panic_str("no such ant"));
        a.settle(env::block_timestamp());
        require!(shares.0 <= a.supply, "more than supply");
        let (c, b) = Self::quote_sell_inner(&self.config, &a, shares.0);
        U128(c + b)
    }

    pub fn holdings_of(&self, account_id: AccountId) -> Vec<(String, U128)> {
        self.holdings
            .get(&account_id)
            .map(|hs| hs.iter().map(|h| (h.clone(), U128(self.balance_of(h, &account_id)))).collect())
            .unwrap_or_default()
    }

    pub fn get_stats(&self) -> Stats {
        let now = env::block_timestamp();
        let (mut agents, mut alive, mut backing, mut reserve) = (0u32, 0u32, 0u128, 0u128);
        for a in self.agents.values() {
            let mut a = a.clone();
            a.settle(now);
            agents += 1;
            if a.alive {
                alive += 1;
            }
            backing += a.backing + a.pending;
            reserve += a.curve_reserve;
        }
        Stats {
            agents,
            alive,
            jobs: self.jobs.len() as u64,
            jobs_awarded: self.jobs_awarded,
            wages_total: U128(self.wages_total),
            fees_total: U128(self.fees_total),
            backing_total: U128(backing),
            reserve_total: U128(reserve),
            inference_owed: U128(self.inference_owed),
        }
    }
}

// ---------------- internal ----------------

impl Contract {
    fn agent_mut(&mut self, handle: &String) -> &mut Agent {
        self.agents.get_mut(handle).unwrap_or_else(|| env::panic_str("no such ant"))
    }

    /// (curve_cost, backing_in, fee, total)
    fn quote_buy_inner(cfg: &Config, a: &Agent, n: u128) -> (u128, u128, u128, u128) {
        let curve = curve_cost(cfg.base_price.0, cfg.slope.0, a.supply, a.supply + n);
        let backing_in = if a.supply == 0 { 0 } else { ceil_div(n * a.backing, a.supply) };
        let fee = ceil_div(curve * cfg.buy_fee_bps as u128, BPS);
        (curve, backing_in, fee, curve + backing_in + fee)
    }

    fn quote_sell_inner(cfg: &Config, a: &Agent, n: u128) -> (u128, u128) {
        require!(n <= a.supply, "more than supply");
        let curve = curve_cost(cfg.base_price.0, cfg.slope.0, a.supply - n, a.supply).min(a.curve_reserve);
        let back = if a.supply == 0 { 0 } else { n * a.backing / a.supply };
        (curve, back)
    }

    fn balance_of(&self, handle: &str, account: &AccountId) -> u128 {
        self.balances.get(&bal_key(handle, account)).copied().unwrap_or(0)
    }

    fn add_balance(&mut self, handle: &str, account: &AccountId, n: u128) {
        let k = bal_key(handle, account);
        let cur = self.balances.get(&k).copied().unwrap_or(0);
        if cur == 0 {
            let mut hs = self.holdings.get(account).cloned().unwrap_or_default();
            if !hs.iter().any(|h| h == handle) {
                hs.push(handle.to_string());
                self.holdings.insert(account.clone(), hs);
            }
        }
        self.balances.insert(k, cur + n);
    }

    fn sub_balance(&mut self, handle: &str, account: &AccountId, n: u128) {
        let k = bal_key(handle, account);
        let cur = self.balances.get(&k).copied().unwrap_or(0);
        require!(cur >= n, "not enough balance");
        if cur == n {
            self.balances.remove(&k);
            if let Some(mut hs) = self.holdings.get(account).cloned() {
                hs.retain(|h| h != handle);
                if hs.is_empty() {
                    self.holdings.remove(account);
                } else {
                    self.holdings.insert(account.clone(), hs);
                }
            }
        } else {
            self.balances.insert(k, cur - n);
        }
    }

    fn view_agent(&self, a: &Agent) -> AgentView {
        let mut a = a.clone();
        a.settle(env::block_timestamp());
        let cfg = &self.config;
        let bps = if a.supply == 0 { 0 } else { a.backing / a.supply };
        let spot = a.spot(cfg);
        AgentView {
            handle: a.handle.clone(),
            account_id: a.account_id.clone(),
            name: a.name.clone(),
            persona: a.persona.clone(),
            skills: a.skills.clone(),
            creator: a.creator.clone(),
            created_ns: U64(a.created_ns),
            budget: U128(a.budget),
            supply: U128(a.supply),
            curve_reserve: U128(a.curve_reserve),
            backing: U128(a.backing),
            pending: U128(a.pending),
            vest_end_ns: U64(a.vest_end),
            spot_price: U128(spot),
            backing_per_share: U128(bps),
            market_cap: U128(spot * a.supply),
            alive: a.alive,
            can_work: a.alive && a.budget >= cfg.submit_fee.0 + MIN_ANSWER_BYTES * env::storage_byte_cost().as_yoctonear(),
            starving_since_ns: a.starving_since.map(U64),
            wins: a.wins,
            submissions: a.submissions,
            wages_total: U128(a.wages_total),
            fees_paid: U128(a.fees_paid),
            history: a.history.iter().map(|(t, p)| (U64(*t), U128(*p))).collect(),
        }
    }

    fn view_job(&self, j: &Job) -> JobView {
        let now = env::block_timestamp();
        JobView {
            id: U64(j.id),
            poster: j.poster.clone(),
            title: j.title.clone(),
            spec: j.spec.clone(),
            reward: U128(j.reward),
            created_ns: U64(j.created_ns),
            deadline_ns: U64(j.deadline_ns),
            status: j.status.clone(),
            submissions: j.submissions.clone(),
            winner: j.verdict.as_ref().and_then(|v| v.winner.clone()),
            verdict: j.verdict.clone(),
            closed_ns: j.closed_ns.map(U64),
            reviewable: j.status == JobStatus::Open
                && !j.submissions.is_empty()
                && (now >= j.deadline_ns || j.submissions.len() >= self.config.max_submissions as usize),
        }
    }
}

#[cfg(test)]
mod tests;
