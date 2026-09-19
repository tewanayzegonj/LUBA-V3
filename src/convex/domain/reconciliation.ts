/**
 * LUBA V1 — pure reconciliation helpers (read-only).
 *
 * Backend Schema §4.2 / TRD §25: the ledger is the truth; the wallet is a
 * projection reconciled against per-account posting sums. These helpers are
 * the calculation layer for that reconciliation — pure functions over
 * posting-shaped data, no ctx, no db, no mutation, no wallet updates.
 *
 * Sign convention: debits are POSITIVE amounts; credits are NEGATIVE
 * amounts. `sum` for an account is therefore the signed balance expressed
 * from that account's perspective. Note the double-entry semantics in LUBA:
 * money ENTERS a wallet on a CREDIT of the wallet account (wallet is a
 * liability of the platform), and leaves on a DEBIT.
 */

import { walletAccount } from "./contracts";

/** Minimal posting shape used for calculations (as now stored / as fetched). */
export type ReconciliationPosting = {
  account: string;
  direction: "debit" | "credit";
  amountSantim: number;
  /** Wallet-account owner when `account` is `wallet:{userId}`. */
  userSide?: string | null;
};

/** Signed amount of one posting from its account's perspective. */
function signedAmount(posting: ReconciliationPosting): number {
  return posting.direction === "debit" ? posting.amountSantim : -posting.amountSantim;
}

/**
 * Transaction balance: net of one entry's postings. Legal journal entries
 * are exactly 0 — any other value means the entry is unbalanced.
 */
export function transactionBalance(postings: readonly ReconciliationPosting[]): number {
  let total = 0;
  for (const posting of postings) total += signedAmount(posting);
  return total;
}

/**
 * Per-account balances from any set of postings (typically one account's
 * `by_account_created` index range). Deterministic; order-independent.
 */
export function accountBalances(
  postings: readonly ReconciliationPosting[],
): Map<string, number> {
  const balances = new Map<string, number>();
  for (const posting of postings) {
    const current = balances.get(posting.account) ?? 0;
    balances.set(posting.account, current + signedAmount(posting));
  }
  return balances;
}

/** Balance of a single account from a posting set (0 when absent). */
export function accountBalance(
  postings: readonly ReconciliationPosting[],
  account: string,
): number {
  let total = 0;
  for (const posting of postings) {
    if (posting.account === account) total += signedAmount(posting);
  }
  return total;
}

/** A wallet projection snapshot to reconcile against the ledger. */
export type WalletProjectionInput = {
  userId: string;
  availableSantim: number;
};

/**
 * Wallet reconciliation input: compares the wallet projection with the
 * ledger's wallet-account balance expressed CREDIT-POSITIVE (the user's
 * perspective: a credit to `wallet:{userId}` increases their available
 * balance). The raw signed sum is debit-positive (platform-books
 * perspective, where the wallet account is a liability), so the comparison
 * negates it. Returns structured comparison inputs; callers decide outcomes.
 */
export function walletReconciliation(
  wallet: WalletProjectionInput,
  postings: readonly ReconciliationPosting[],
): {
  ledgerBalanceSantim: number;
  walletAvailableSantim: number;
  differenceSantim: number;
  matches: boolean;
} {
  const ledgerBalance = -accountBalance(postings, walletAccount(wallet.userId));
  const difference = wallet.availableSantim - ledgerBalance;
  return {
    ledgerBalanceSantim: ledgerBalance,
    walletAvailableSantim: wallet.availableSantim,
    differenceSantim: difference,
    matches: difference === 0,
  };
}

/* ── Wallet-set reconciliation (read-only) ──
 * Inputs for the reconciliation job (Phase M exception queues): the ledger
 * stays the source of truth; the wallet table is only ever a projection.
 * All findings are REPORTED here — never repaired by writes — and users
 * are identified by their wallet-account string (`wallet:{userId}`).
 */

export type WalletSetFinding =
  /** No postings exist for a wallet that has a projection row. */
  | { type: "no_ledger_activity"; account: string; availableSantim: number }
  /** A wallet account has postings but no projection row. */
  | { type: "missing_wallet"; account: string; ledgerBalanceSantim: number }
  /** Negative available balance on a projection row (never legal). */
  | { type: "negative_balance"; account: string; availableSantim: number }
  /** Projection and ledger disagree on the available balance. */
  | {
      type: "balance_divergence";
      account: string;
      ledgerBalanceSantim: number;
      walletAvailableSantim: number;
      differenceSantim: number;
    };

export type WalletSetReconciliation = {
  findings: WalletSetFinding[];
  reconciledCount: number;
};

/**
 * Reconcile a set of wallet projections against the ledger postings of
 * their wallet accounts. Read-only: returns findings; callers decide what
 * to do (report/queue for operators). Order-independent and deterministic.
 */
export function reconcileWalletProjections(
  wallets: readonly WalletProjectionInput[],
  postings: readonly ReconciliationPosting[],
): WalletSetReconciliation {
  const findings: WalletSetFinding[] = [];

  // Negative balances are illegal regardless of ledger agreement.
  for (const wallet of wallets) {
    if (wallet.availableSantim < 0 || !Number.isInteger(wallet.availableSantim)) {
      findings.push({
        type: "negative_balance",
        account: walletAccount(wallet.userId),
        availableSantim: wallet.availableSantim,
      });
    }
  }

  const ledgerByUser = new Map<string, number>();
  for (const posting of postings) {
    if (!posting.account.startsWith("wallet:")) continue;
    const userId = posting.account.slice("wallet:".length);
    if (userId.length === 0) continue;
    ledgerByUser.set(userId, (ledgerByUser.get(userId) ?? 0) + signedAmount(posting));
  }

  const projectedUsers = new Set(wallets.map((w) => w.userId));

  // Projection rows vs ledger balances (credit-positive user perspective).
  for (const wallet of wallets) {
    if (!ledgerByUser.has(wallet.userId)) {
      findings.push({
        type: "no_ledger_activity",
        account: walletAccount(wallet.userId),
        availableSantim: wallet.availableSantim,
      });
      continue;
    }
    const ledgerBalance = -(ledgerByUser.get(wallet.userId) ?? 0);
    const difference = wallet.availableSantim - ledgerBalance;
    if (difference !== 0) {
      findings.push({
        type: "balance_divergence",
        account: walletAccount(wallet.userId),
        ledgerBalanceSantim: ledgerBalance,
        walletAvailableSantim: wallet.availableSantim,
        differenceSantim: difference,
      });
    }
  }

  // Ledger accounts with activity but no projection row.
  for (const [userId, rawBalance] of ledgerByUser) {
    if (!projectedUsers.has(userId)) {
      findings.push({
        type: "missing_wallet",
        account: walletAccount(userId),
        ledgerBalanceSantim: -rawBalance,
      });
    }
  }

  const reconciledCount = wallets.filter((wallet) => {
    const ledger = ledgerByUser.get(wallet.userId);
    return (
      ledger !== undefined &&
      wallet.availableSantim >= 0 &&
      wallet.availableSantim === -ledger
    );
  }).length;

  return { findings, reconciledCount };
}
