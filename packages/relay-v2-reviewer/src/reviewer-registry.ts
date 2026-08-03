import type { RelayReviewer } from "./reviewer-contract.js";

export class ReviewerRegistry {
  private readonly reviewers: Map<string, RelayReviewer>;

  constructor(reviewers: readonly RelayReviewer[]) {
    this.reviewers = new Map(reviewers.map(reviewer => [reviewer.id, reviewer]));
    if (this.reviewers.size !== reviewers.length) throw new Error("Reviewer IDs must be unique.");
    for (const reviewer of reviewers) reviewer.describe();
  }

  get(id: string): RelayReviewer | undefined { return this.reviewers.get(id); }
  require(id: string): RelayReviewer {
    const reviewer = this.get(id);
    if (!reviewer) throw new Error(`Reviewer '${id}' is not registered.`);
    return reviewer;
  }
  list(): RelayReviewer[] { return [...this.reviewers.values()]; }
}
