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

/** Minimal posting shape used for calculations (as stored / as fetched). */
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
  const ledgerBalance = -accountBalance(postings, walletAccountOf(wallet.userId));
  const difference = wallet.availableSantim - ledgerBalance;
  return {
    ledgerBalanceSantim: ledgerBalance,
    walletAvailableSantim: wallet.availableSantim,
    differenceSantim: difference,
    matches: difference === 0,
  };
}

/** The wallet account string for a user (mirrors contracts.walletAccount). */
function walletAccountOf(userId: string): string {
  return `wallet:${userId}`;
}
