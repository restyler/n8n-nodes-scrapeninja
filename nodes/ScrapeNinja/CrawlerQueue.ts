import pLimit from 'p-limit';

export class CrawlerQueue {
	private limit: ReturnType<typeof pLimit>;
	private activePromises: Set<Promise<any>>;
	private stopped = false;

	constructor(concurrency: number) {
		this.limit = pLimit(concurrency);
		this.activePromises = new Set();
	}

	async add(task: () => Promise<any>): Promise<any> {
		if (this.stopped) return;

		const wrappedTask = async () => {
			try {
				return await task();
			} catch (error) {
				// Ensure errors in tasks don't break the queue
				throw error;
			}
		};

		const promise = this.limit(wrappedTask);
		this.activePromises.add(promise);

		try {
			const result = await promise;
			return result;
		} finally {
			this.activePromises.delete(promise);
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await Promise.all(Array.from(this.activePromises));
	}

	get pending(): number {
		return this.activePromises.size;
	}
} 