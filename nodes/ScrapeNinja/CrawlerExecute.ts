import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { IDatabase, ITask } from 'pg-promise';
import * as cheerio from 'cheerio';
import { minimatch } from 'minimatch';

interface IScrapeResult {
	info: {
		statusCode: number;
		finalUrl: string;
		headers: string[];
	};
	body: string;
}

interface ICrawlerQueue {
	id: number;
	run_id: number;
	url: string;
	status: 'pending' | 'processing' | 'completed' | 'failed';
	parent_url: string | null;
	depth: number;
	created_at: Date;
	updated_at: Date;
	error?: string;
	response_html?: string;
	response_status_code?: number;
	response_final_url?: string;
}

function shouldProcessUrl(url: string, includePatterns: string[], excludePatterns: string[]): boolean {
	// If no include patterns are specified, include all URLs by default
	let shouldInclude = includePatterns.length === 0;

	// Check include patterns
	for (const pattern of includePatterns) {
		if (minimatch(url, pattern)) {
			shouldInclude = true;
			break;
		}
	}

	// Check exclude patterns - these take precedence over include patterns
	for (const pattern of excludePatterns) {
		if (minimatch(url, pattern)) {
			return false;
		}
	}

	return shouldInclude;
}

// Add custom logger that writes to DB
async function logToCrawler(
	this: IExecuteFunctions,
	db: IDatabase<any>,
	runId: number,
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
	metadata?: any,
) {
	// Log to n8n logger
	this.logger[level](message, { ...metadata, runId });

	// Log to database
	await db.none(
		`INSERT INTO crawler_logs (run_id, level, message, metadata) 
		VALUES ($1, $2, $3, $4)`,
		[runId, level, message, metadata ? JSON.stringify(metadata) : null],
	);
}

async function cancelRemainingItems(
	db: IDatabase<any>,
	runId: number,
	reason: string,
): Promise<void> {
	await db.tx(async (t: ITask<any>) => {
		// Update all pending and processing items to canceled
		await t.none(
			`UPDATE crawler_queue 
			SET status = 'canceled', 
				error = $1,
				updated_at = CURRENT_TIMESTAMP 
			WHERE run_id = $2 
			AND status IN ('pending', 'processing')`,
			[reason, runId],
		);

		// Update run status
		await t.none(
			`UPDATE crawler_runs 
			SET status = 'canceled', 
				updated_at = CURRENT_TIMESTAMP 
			WHERE id = $1`,
			[runId],
		);
	});
}

export async function processCrawlerQueue(
	this: IExecuteFunctions,
	db: IDatabase<any>,
	runId: number,
	maxDepth: number,
	maxPages: number,
	includePatterns: string[] = [],
	excludePatterns: string[] = [],
	crawlExternal: boolean = false,
): Promise<void> {
	const log = logToCrawler.bind(this, db, runId);
	await log('info', `Starting crawler process for run "${runId}"`, { maxDepth, maxPages });
	let processedPages = 0;

	try {
		while (processedPages < maxPages) {
			// Get next URL from queue using a transaction
			this.logger.debug(`Fetching next URL to process for run "${runId}"`, { runId, processedPages });
			const queueItem = await db.tx(async (t: ITask<any>) => {
				const queueResult = await t.oneOrNone<ICrawlerQueue>(
					`UPDATE crawler_queue 
					SET status = 'processing', updated_at = CURRENT_TIMESTAMP
					WHERE id = (
						SELECT id FROM crawler_queue 
						WHERE run_id = $1 AND status = 'pending'
						ORDER BY depth ASC, created_at ASC 
						LIMIT 1
					)
					RETURNING *`,
					[runId],
				);

				if (!queueResult) {
					this.logger.info(`No more URLs to process for run "${runId}", marking as completed`, { runId });
					await t.none(
						'UPDATE crawler_runs SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
						['completed', runId],
					);
					return null;
				}

				this.logger.debug(`Selected URL "${queueResult.url}" for processing`, { 
					runId,
					url: queueResult.url,
					depth: queueResult.depth,
					queueId: queueResult.id,
				});
				return queueResult;
			});

			if (!queueItem) break;

			try {
				// Check if run is still active
				const runStatus = await db.oneOrNone<{ status: string }>(
					'SELECT status FROM crawler_runs WHERE id = $1',
					[runId],
				);

				if (!runStatus || runStatus.status !== 'running') {
					this.logger.info(`Crawler run "${runId}" is no longer active (status: ${runStatus?.status})`, { runId });
					break;
				}

				this.logger.debug(`Fetching page "${queueItem.url}" using ScrapeNinja`, { runId, url: queueItem.url });
				// Use ScrapeNinja to fetch the page
				const credentials = await this.getCredentials('scrapeNinjaApi');
				
				const headers: Record<string, string> = {
					'Content-Type': 'application/json',
				};

				// Decide endpoint based on marketplace
				const marketplace = (credentials as any).marketplace || 'rapidapi';
				const endpoint = marketplace === 'rapidapi' 
					? 'https://scrapeninja.p.rapidapi.com/scrape'
					: 'https://scrapeninja.apiroad.net/scrape';

				// Set authentication headers based on marketplace
				if (marketplace === 'rapidapi') {
					headers['X-RapidAPI-Key'] = credentials.apiKey as string;
					headers['X-RapidAPI-Host'] = 'scrapeninja.p.rapidapi.com';
				} else {
					headers['X-Apiroad-Key'] = credentials.apiKey as string;
				}

				// add debug of what request is sent and where
				this.logger.debug(`Sending request to ${endpoint}`, { 
					runId,
					url: queueItem.url,
					headers,
					marketplace,
				});

				const scrapeResult = await this.helpers.httpRequest({
					method: 'POST',
					url: endpoint,
					headers,
					body: {
						url: queueItem.url,
						followRedirects: 1,
					},
					json: true,
				}) as IScrapeResult;

				// Store response data
				await db.none(
					`UPDATE crawler_queue 
					SET response_html = $1, 
						response_status_code = $2, 
						response_final_url = $3
					WHERE id = $4`,
					[
						scrapeResult.body,
						scrapeResult.info.statusCode,
						scrapeResult.info.finalUrl,
						queueItem.id,
					],
				);

				// Extract links using cheerio
				const $ = cheerio.load(scrapeResult.body);
				const links = new Set<string>();
				const baseHostname = new URL(queueItem.url).hostname;

				// Log the response info for debugging
				this.logger.debug(`ScrapeNinja response info for "${queueItem.url}"`, { 
					runId,
					url: queueItem.url,
					statusCode: scrapeResult.info.statusCode,
					finalUrl: scrapeResult.info.finalUrl,
				});

				$('a[href]').each((_, element) => {
					const href = $(element).attr('href');
					if (href) {
						// Skip empty and javascript: URLs
						if (!href.trim() || href.startsWith('javascript:') || href === '#') {
							return;
						}

						// Handle relative URLs
						let url: URL;
						// Use finalUrl if available, otherwise fall back to original URL
						const baseUrl = scrapeResult.info.finalUrl || queueItem.url;

						try {
							// First try as absolute URL
							url = new URL(href);
						} catch {
							try {
								// Then try as relative URL
								url = new URL(href, baseUrl);
							} catch (e) {
								this.logger.debug(`Invalid URL: "${href}" (base: ${baseUrl})`, { 
									runId, 
									parentUrl: queueItem.url,
									reason: e.message,
								});
								return;
							}
						}

						// Skip non-HTTP/HTTPS URLs
						if (url.protocol !== 'http:' && url.protocol !== 'https:') {
							return;
						}

						// Check if URL is external and skip if crawlExternal is false
						if (!crawlExternal && url.hostname !== baseHostname) {
							return;
						}

						// Check URL patterns
						if (shouldProcessUrl(url.href, includePatterns, excludePatterns)) {
							links.add(url.href);
						}
					}
				});

				this.logger.debug(`Found ${links.size} links on page "${queueItem.url}"`, { 
					runId,
					url: queueItem.url,
					linksCount: links.size,
				});

				let linksQueued = 0;

				// Add new URLs to queue if within depth limit using a transaction
				if (queueItem.depth < maxDepth) {
					await db.tx(async (t: ITask<any>) => {
						// Create a unique index on run_id and normalized_url if it doesn't exist
						await t.none(`
							CREATE INDEX IF NOT EXISTS idx_crawler_queue_url_dedup 
							ON crawler_queue(run_id, url);
						`);

						const queries = Array.from(links).map(async (link) => {
							// Check if URL has already been processed or queued for this run
							const exists = await t.oneOrNone(
								'SELECT id FROM crawler_queue WHERE run_id = $1 AND url = $2',
								[runId, link],
							);

							if (!exists) {
								linksQueued++;
								return t.none(
									'INSERT INTO crawler_queue (run_id, url, status, parent_url, depth) VALUES ($1, $2, $3, $4, $5)',
									[runId, link, 'pending', queueItem.url, queueItem.depth + 1],
								);
							}
							return undefined;
						});

						await t.batch(queries.filter((q) => q !== undefined));
					});

					this.logger.debug(`Queued ${linksQueued} new URLs for crawling`, { 
						runId,
						parentUrl: queueItem.url,
						linksQueued,
						currentDepth: queueItem.depth,
					});
				}

				// Mark current URL as completed
				await db.none(
					'UPDATE crawler_queue SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
					['completed', queueItem.id],
				);

				// Get queue stats
				const stats = await db.one<{ total: string, pending: string, completed: string, failed: string }>(
					`SELECT 
						COUNT(*) as total,
						COUNT(*) FILTER (WHERE status = 'pending') as pending,
						COUNT(*) FILTER (WHERE status = 'completed') as completed,
						COUNT(*) FILTER (WHERE status = 'failed') as failed
					FROM crawler_queue 
					WHERE run_id = $1`,
					[runId],
				);

				// Log progress
				this.logger.info(`Successfully processed page "${queueItem.url}"`, {
					url: queueItem.url,
					status: 'completed',
					parent_url: queueItem.parent_url,
					depth: queueItem.depth,
					links_found: links.size,
					links_queued: linksQueued,
					run_id: runId,
					processed_pages: processedPages + 1,
					max_pages: maxPages,
					queue_stats: {
						total: parseInt(stats.total),
						pending: parseInt(stats.pending),
						completed: parseInt(stats.completed),
						failed: parseInt(stats.failed),
					},
					timestamp: new Date().toISOString(),
				});

				processedPages++;

				// Break if we've reached maxPages
				if (processedPages >= maxPages) {
					await log('info', `Reached maximum pages (${maxPages}), stopping crawler`, { 
						processedPages,
						maxPages,
					});
					await cancelRemainingItems(db, runId, `Reached maximum pages limit (${maxPages})`);
					break;
				}
			} catch (error) {
				this.logger.error(`Failed to process page "${queueItem.url}"`, { 
					runId,
					url: queueItem.url,
					error: error.message,
					depth: queueItem.depth,
				});

				// Mark URL as failed and check failure count in a transaction
				const shouldStopCrawling = await db.tx(async (t: ITask<any>) => {
					await t.none(
						'UPDATE crawler_queue SET status = $1, error = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
						['failed', error.message, queueItem.id],
					);

					const failedCount = await t.one<{ count: number }>(
						'SELECT COUNT(*) as count FROM crawler_queue WHERE run_id = $1 AND status = $2',
						[runId, 'failed'],
					);

					if (failedCount.count > 10) {
						this.logger.warn(`Too many failed requests (${failedCount.count}) for run "${runId}", stopping crawler`, {
							runId,
							failedCount: failedCount.count,
						});
						await t.none(
							'UPDATE crawler_runs SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
							['failed', runId],
						);
						return true;
					}

					return false;
				});

				// Get queue stats
				const stats = await db.one<{ total: string, pending: string, completed: string, failed: string }>(
					`SELECT 
						COUNT(*) as total,
						COUNT(*) FILTER (WHERE status = 'pending') as pending,
						COUNT(*) FILTER (WHERE status = 'completed') as completed,
						COUNT(*) FILTER (WHERE status = 'failed') as failed
					FROM crawler_queue 
					WHERE run_id = $1`,
					[runId],
				);

				// Log error details
				this.logger.error(`Error details for failed page "${queueItem.url}"`, {
					url: queueItem.url,
					status: 'failed',
					parent_url: queueItem.parent_url,
					depth: queueItem.depth,
					error: error.message,
					run_id: runId,
					processed_pages: processedPages,
					max_pages: maxPages,
					queue_stats: {
						total: parseInt(stats.total),
						pending: parseInt(stats.pending),
						completed: parseInt(stats.completed),
						failed: parseInt(stats.failed),
					},
					timestamp: new Date().toISOString(),
				});

				if (shouldStopCrawling) {
					await cancelRemainingItems(db, runId, 'Too many failed requests');
					throw new NodeOperationError(this.getNode(), 'Too many failed requests, stopping crawler');
				}
			}
		}
	} catch (error) {
		// Cancel remaining items on error
		await cancelRemainingItems(db, runId, error.message);
		throw error;
	} finally {
		// Check if there are any remaining pending/processing items
		const pendingCount = await db.one<{ count: string }>(
			`SELECT COUNT(*) as count 
			FROM crawler_queue 
			WHERE run_id = $1 AND status IN ('pending', 'processing')`,
			[runId],
		);

		if (parseInt(pendingCount.count) > 0) {
			await cancelRemainingItems(db, runId, 'Crawler process ended');
		} else {
			// Only mark as completed if no items were canceled
			await db.none(
				'UPDATE crawler_runs SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
				['completed', runId],
			);
		}
		
		await log('info', `Crawler process completed for run "${runId}"`, { 
			processedPages,
			maxPages,
		});
	}
} 