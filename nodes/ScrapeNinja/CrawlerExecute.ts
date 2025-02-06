import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { IDatabase, ITask } from 'pg-promise';
import * as cheerio from 'cheerio';
import { minimatch } from 'minimatch';
import { IScrapeSettings } from './types';
import { CrawlerQueue } from './CrawlerQueue';

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
	page_title?: string;
}

function shouldProcessUrl(url: string, includePatterns: string[], excludePatterns: string[]): boolean {
	// If no include patterns are specified, include all URLs by default
	let shouldInclude = includePatterns.length === 0;

	// Convert URL to a format that works better with minimatch
	const urlForMatching = url.replace(/^https?:\/\//, '');

	// Check include patterns
	for (const pattern of includePatterns) {
		// Remove protocol from pattern if present
		const cleanPattern = pattern.replace(/^https?:\/\//, '');
		
		if (minimatch(urlForMatching, cleanPattern)) {
			shouldInclude = true;
			break;
		}
	}

	// Check exclude patterns - these take precedence over include patterns
	for (const pattern of excludePatterns) {
		const cleanPattern = pattern.replace(/^https?:\/\//, '');
		
		if (minimatch(urlForMatching, cleanPattern)) {
			return false;
		}
	}

	return shouldInclude;
}

// Update logToCrawler function to handle all log levels
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

	// Always log to database regardless of level
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

function normalizeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		// Remove hash fragment
		parsed.hash = '';
		// Remove trailing slash if it's the only path component
		if (parsed.pathname === '/') {
			parsed.pathname = '';
		}
		// Remove default ports
		if ((parsed.protocol === 'http:' && parsed.port === '80') || 
			(parsed.protocol === 'https:' && parsed.port === '443')) {
			parsed.port = '';
		}
		// Always use lowercase hostname
		parsed.hostname = parsed.hostname.toLowerCase();
		return parsed.toString();
	} catch {
		// If URL parsing fails, return original
		return url;
	}
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
	settings: IScrapeSettings,
	concurrency: number = 1,
): Promise<void> {
	const queue = new CrawlerQueue(concurrency);
	let processedPages = 0;
	let isProcessing = true;
	let linksQueued = 0;

	try {
		// Start concurrent processors
		const processors = Array.from({ length: concurrency }).map(async () => {
			while (isProcessing && processedPages < maxPages) {
				// Get next batch of URLs to process
				const queueItem = await db.tx(async (t: ITask<any>) => {
					const queueResult = await t.oneOrNone<ICrawlerQueue>(
						`UPDATE crawler_queue 
						SET status = 'processing', updated_at = CURRENT_TIMESTAMP
						WHERE id = (
							SELECT id FROM crawler_queue 
							WHERE run_id = $1 AND status = 'pending'
							ORDER BY depth ASC, created_at ASC 
							FOR UPDATE SKIP LOCKED
							LIMIT 1
						)
						RETURNING *`,
						[runId],
					);

					if (!queueResult) {
						return null;
					}

					logToCrawler.call(this, db, runId, 'debug', `Selected URL "${queueResult.url}" for processing`, { 
						runId,
						url: queueResult.url,
						depth: queueResult.depth,
						queueId: queueResult.id,
					});
					return queueResult;
				});

				if (!queueItem) {
					const stats = await db.one<{
						total: string;
						pending: string;
						completed: string;
						failed: string;
					}>(
						`SELECT 
							COUNT(*) as total,
							COUNT(*) FILTER (WHERE status = 'pending') as pending,
							COUNT(*) FILTER (WHERE status = 'completed') as completed,
							COUNT(*) FILTER (WHERE status = 'failed') as failed
						FROM crawler_queue 
						WHERE run_id = $1`,
						[runId],
					);
				
					// If there are no pending items, stop processing.
					if (parseInt(stats.pending) === 0) {
						isProcessing = false;
						// Optionally, mark the run as failed if no pages were processed successfully.
						if (parseInt(stats.completed) === 0) {
							logToCrawler.call(
								this,
								db,
								runId,
								'warn',
								'No URLs processed successfully, stopping crawler',
								{
									runId,
									queue_stats: {
										total: parseInt(stats.total),
										pending: parseInt(stats.pending),
										completed: parseInt(stats.completed),
										failed: parseInt(stats.failed),
									},
								},
							);
							await db.none(
								'UPDATE crawler_runs SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
								['failed', runId],
							);
						}
						break; // exit the worker loop
					}
				
					// No items available now; wait before trying again.
					await new Promise((resolve) => setTimeout(resolve, 1000));
					continue;
				}

				// Process the URL
				await queue.add(async () => {
					let requestStartTime = Date.now();
					try {
						// Check if run is still active
						const runStatus = await db.oneOrNone<{ status: string }>(
							'SELECT status FROM crawler_runs WHERE id = $1',
							[runId],
						);

						if (!runStatus || runStatus.status !== 'running') {
							logToCrawler.call(this, db, runId, 'info', `Crawler run "${runId}" is no longer active (status: ${runStatus?.status})`, { runId });
							return;
						}

						logToCrawler.call(this, db, runId, 'debug', `Fetching page "${queueItem.url}" using ScrapeNinja`, { runId, url: queueItem.url });
						
						// Reset timer just before the actual request
						requestStartTime = Date.now();

						// Use ScrapeNinja to fetch the page
						const credentials = await this.getCredentials('scrapeNinjaApi');
						
						// Decide endpoint based on marketplace and engine
						const marketplace = (credentials as any).marketplace || 'rapidapi';
						const endpoint = settings.engine === 'scrape'
							? marketplace === 'rapidapi' 
								? 'https://scrapeninja.p.rapidapi.com/scrape'
								: 'https://scrapeninja.apiroad.net/scrape'
							: marketplace === 'rapidapi'
								? 'https://scrapeninja.p.rapidapi.com/scrape-js'
								: 'https://scrapeninja.apiroad.net/scrape-js';

						// Set authentication headers based on marketplace
						const headers: Record<string, string> = {
							'Content-Type': 'application/json',
						};

						if (marketplace === 'rapidapi') {
							headers['X-RapidAPI-Key'] = credentials.apiKey as string;
							headers['X-RapidAPI-Host'] = 'scrapeninja.p.rapidapi.com';
						} else {
							headers['X-Apiroad-Key'] = credentials.apiKey as string;
						}

						// Build request body based on engine
						const body: Record<string, any> = {
							url: queueItem.url,
						};

						// Only add non-empty arrays and defined values
						if (settings.headers?.length > 0) {
							body.headers = settings.headers;
						}

						if (settings.retryNum > 0) {
							body.retryNum = settings.retryNum;
						}

						if (settings.textNotExpected?.length > 0) {
							body.textNotExpected = settings.textNotExpected;
						}

						if (settings.statusNotExpected?.length > 0) {
							body.statusNotExpected = settings.statusNotExpected;
						}

						// Add geo only if not using custom proxy
						if (settings.geo !== '_custom') {
							body.geo = settings.geo;
						}

						// Add proxy if using custom proxy and it's not empty
						if (settings.geo === '_custom' && settings.proxy) {
							body.proxy = settings.proxy;
						}

						// Add engine-specific options
						if (settings.engine === 'scrape') {
							if (settings.followRedirects !== undefined) {
								body.followRedirects = settings.followRedirects ? 1 : 0;
							}
							if (settings.timeout) {
								body.timeout = settings.timeout;
							}
						} else {
							// scrape-js specific options
							if (settings.timeoutJs) {
								body.timeoutJs = settings.timeoutJs;
							}
							if (settings.waitForSelector) {
								body.waitForSelector = settings.waitForSelector;
							}
							if (settings.blockImages) {
								body.blockImages = settings.blockImages;
							}
							if (settings.blockMedia) {
								body.blockMedia = settings.blockMedia;
							}
							if (settings.postWaitTime) {
								body.postWaitTime = settings.postWaitTime;
							}
						}

						logToCrawler.call(this, db, runId, 'debug', `Sending request to ${endpoint}`, { 
							runId,
							url: queueItem.url,
							marketplace,
							engine: settings.engine,
						});

						const scrapeResult = await this.helpers.httpRequest({
							method: 'POST',
							url: endpoint,
							headers,
							body,
							json: true,
						}) as IScrapeResult;

						// Calculate request latency
						const requestLatencyMs = Date.now() - requestStartTime;

						// Extract page title and links from HTML
						const $ = cheerio.load(scrapeResult.body);
						const allLinks = new Set<string>();
						const ignoredLinks = new Set<string>();
						const includedLinks = new Set<string>();

						$('a[href]').each((_, element) => {
							const href = $(element).attr('href');
							if (!href) return;

							try {
								// Resolve relative URLs
								const resolvedUrl = new URL(href, queueItem.url).toString();
								const normalizedUrl = normalizeUrl(resolvedUrl);
								allLinks.add(normalizedUrl);
								
								if (shouldProcessUrl(normalizedUrl, includePatterns, excludePatterns)) {
									if (crawlExternal || new URL(normalizedUrl).hostname === new URL(queueItem.url).hostname) {
										includedLinks.add(normalizedUrl);
									} else {
										ignoredLinks.add(normalizedUrl);
									}
								} else {
									ignoredLinks.add(normalizedUrl);
								}
							} catch (e) {
								logToCrawler.call(this, db, runId, 'debug', `Skipping invalid URL "${href}"`, { 
									runId,
									parentUrl: queueItem.url,
									error: e.message,
								});
							}
						});

						// Detailed logging for the first page only
						if (processedPages === 0) {
							const ignoredLinksArray = Array.from(ignoredLinks);
							const includedLinksArray = Array.from(includedLinks);
							
							logToCrawler.call(this, db, runId, 'info', `First page link analysis for "${queueItem.url}"`, { 
								runId,
								total_links_found: allLinks.size,
								links_included: includedLinks.size,
								links_ignored: ignoredLinks.size,
								sample_ignored_links: ignoredLinksArray.slice(0, 30),
								sample_included_links: includedLinksArray.slice(0, 10),
								include_patterns: includePatterns,
								exclude_patterns: excludePatterns,
								crawl_external: crawlExternal,
							});
						}

						// Store response data
						await db.none(
							`UPDATE crawler_queue 
							SET response_html = $1, 
								response_status_code = $2, 
								response_final_url = $3,
								page_title = $4
							WHERE id = $5`,
							[
								scrapeResult.body,
								scrapeResult.info.statusCode,
								scrapeResult.info.finalUrl,
								$('title').text().trim().substring(0, 250),
								queueItem.id,
							],
						);

						logToCrawler.call(this, db, runId, 'debug', `ScrapeNinja response info for "${queueItem.url}"`, { 
							runId,
							url: queueItem.url,
							statusCode: scrapeResult.info.statusCode,
							finalUrl: scrapeResult.info.finalUrl,
							pageTitle: $('title').text().trim().substring(0, 250),
						});

						// Add included links to the queue
						if (queueItem.depth < maxDepth) {
							await db.tx(async (t: ITask<any>) => {
								// Get all existing URLs for this run in one query
								const existingUrls = new Set(
									(await t.manyOrNone<{ url: string }>(
										'SELECT url FROM crawler_queue WHERE run_id = $1',
										[runId],
									)).map(row => row.url)
								);

								// Filter out existing URLs
								const newLinks = Array.from(includedLinks).filter(link => !existingUrls.has(link));
								linksQueued = newLinks.length;

								if (linksQueued > 0) {
									// Prepare batch insert values
									const values = newLinks.map(link => ({
										run_id: runId,
										url: normalizeUrl(link),
										status: 'pending',
										parent_url: queueItem.url,
										depth: queueItem.depth + 1,
									}));

									// Insert all new URLs in one query
									await t.none(
										`INSERT INTO crawler_queue 
										(run_id, url, status, parent_url, depth) 
										SELECT v.run_id, v.url, v.status, v.parent_url, v.depth 
										FROM jsonb_to_recordset($1) AS v(run_id int, url text, status text, parent_url text, depth int)`,
										[JSON.stringify(values)],
									);
								}
							});

							logToCrawler.call(this, db, runId, 'debug', `Queued ${linksQueued} new URLs for crawling`, { 
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

						// Increment processed pages counter here only
						processedPages++;

						// Add latency to success log
						logToCrawler.call(this, db, runId, 'info', `Successfully processed page "${queueItem.url}"`, {
							url: queueItem.url,
							status: 'completed',
							parent_url: queueItem.parent_url,
							depth: queueItem.depth,
							links_found: allLinks.size,
							links_queued: linksQueued,
							run_id: runId,
							processed_pages: processedPages,
							max_pages: maxPages,
							latency_ms: requestLatencyMs,
							queue_stats: {
								total: parseInt(stats.total),
								pending: parseInt(stats.pending),
								completed: parseInt(stats.completed),
								failed: parseInt(stats.failed),
							},
						});

						// Check if we've reached maxPages
						if (processedPages >= maxPages) {
							isProcessing = false;
							logToCrawler.call(this, db, runId, 'info', `Reached maximum pages (${maxPages}), stopping crawler`, { 
								processedPages,
								maxPages,
							});
							await cancelRemainingItems(db, runId, `Reached maximum pages limit (${maxPages})`);
						}
					} catch (error) {
						// Calculate latency even for failed requests
						const requestLatencyMs = Date.now() - requestStartTime;

						// Try to extract response details for errors
						let errorDetails = error.message;
						let errorResponse = null;
						let statusCode = error.response?.statusCode;
						
						if (error.response) {
							try {
								// Handle both string and object responses
								if (typeof error.response.data === 'string') {
									try {
										errorResponse = JSON.parse(error.response.data);
									} catch {
										errorResponse = { body: error.response.data };
									}
								} else {
									errorResponse = error.response.data;
								}
							} catch (e) {
								errorResponse = { 
									raw: error.response.data,
									parse_error: e.message 
								};
							}
						}

						logToCrawler.call(this, db, runId, 'error', `Failed to process page "${queueItem.url}"`, { 
							runId,
							url: queueItem.url,
							error: errorDetails,
							error_response: errorResponse,
							status_code: statusCode,
							depth: queueItem.depth,
							latency_ms: requestLatencyMs,
						});

						// Mark URL as failed and check failure count in a transaction
						const shouldStopCrawling = await db.tx(async (t: ITask<any>) => {
							const errorData = errorResponse
								? JSON.stringify({ message: error.message, response: errorResponse })
								: error.message;
							await t.none(
								'UPDATE crawler_queue SET status = $1, error = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
								['failed', errorData, queueItem.id],
							);

							const failedCount = await t.one<{ count: number }>(
								'SELECT COUNT(*) as count FROM crawler_queue WHERE run_id = $1 AND status = $2',
								[runId, 'failed'],
							);

							if (failedCount.count > 10) {
								logToCrawler.call(this, db, runId, 'warn', `Too many failed requests (${failedCount.count}) for run "${runId}", stopping crawler`, {
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

						logToCrawler.call(this, db, runId, 'error', `Error details for failed page "${queueItem.url}"`, {
							url: queueItem.url,
							status: 'failed',
							parent_url: queueItem.parent_url,
							depth: queueItem.depth,
							error: error.message,
							run_id: runId,
							processed_pages: processedPages,
							max_pages: maxPages,
							latency_ms: requestLatencyMs,
							queue_stats: {
								total: parseInt(stats.total),
								pending: parseInt(stats.pending),
								completed: parseInt(stats.completed),
								failed: parseInt(stats.failed),
							},
						});

						if (shouldStopCrawling) {
							logToCrawler.call(this, db, runId, 'error', 'Too many failed requests, stopping crawler');
							await cancelRemainingItems(db, runId, 'Too many failed requests');
							throw new NodeOperationError(this.getNode(), 'Too many failed requests, stopping crawler');
						}
					}
				});
			}
		});

		// Wait for all processors to complete
		await Promise.all(processors);

	} catch (error) {
		isProcessing = false;
		await queue.stop();
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
		
		logToCrawler.call(this, db, runId, 'info', `Crawler process completed for run "${runId}"`, { 
			processedPages,
			maxPages,
		});
	}
} 