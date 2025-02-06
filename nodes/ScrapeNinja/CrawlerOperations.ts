import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import pgPromise, { IDatabase, ITask } from 'pg-promise';
import { processCrawlerQueue } from './CrawlerExecute';
import { IScrapeSettings } from './types';

interface ICrawlerRun {
	id: number;
	start_url: string;
	status: 'running' | 'completed' | 'failed' | 'canceled';
	max_depth: number;
	max_pages: number;
	concurrency: number;
	include_patterns: string[];
	exclude_patterns: string[];
	crawl_external: boolean;
	settings: IScrapeSettings;
	created_at: Date;
	updated_at: Date;
	completed_at: Date | null;
}

export const crawlerProperties: INodeProperties[] = [
	// Crawler Settings Group
	{
		displayName: 'Crawler Settings. Crawler node can take long time to finish! Please be patient and explore n8n logs to see realtime progress. Also, you can poll Postgres tables crawler_runs and crawler_queue to track the progress and crawler_logs to see detailed crawler logs.',
		name: 'crawlerSettingsHeader',
		type: 'notice',
		default: '',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Start URL',
		name: 'startUrl',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
		placeholder: 'https://example.com',
		description: 'The URL to start crawling from',
	},
	{
		displayName: 'Max Depth',
		name: 'maxDepth',
		type: 'number',
		default: 3,
		description: 'Maximum depth to crawl (1 means only the start page)',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Max Pages',
		name: 'maxPages',
		type: 'number',
		default: 100,
		description: 'Maximum number of pages to crawl',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Concurrent Requests',
		name: 'concurrency',
		type: 'number',
		default: 1,
		description: 'Number of concurrent requests (1-5)',
		typeOptions: {
			minValue: 1,
			maxValue: 5,
		},
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'URL Pattern Matching Guide:\n\n' +
			'Use * to match within a path segment (e.g., /docs/*.html matches /docs/page.html but not /docs/api/page.html)\n' +
			'Use ** to match across path segments (e.g., /docs/** matches /docs/api/reference/page.html)',
		name: 'urlPatternGuide',
		type: 'notice',
		default: '',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'URL Inclusion Patterns',
		name: 'includePatterns',
		type: 'string',
		typeOptions: {
			multipleValues: true,
		},
		default: [],
		placeholder: 'https://example.com/docs/**',
		description: 'Only crawl URLs matching these patterns. Examples:\n' +
			'• example.com/docs/* - match files in docs folder\n' +
			'• example.com/docs/** - match files in docs and all subfolders\n' +
			'• example.com/blog/*.html - match HTML files in blog folder\n' +
			'• example.com/*/index.html - match index.html in direct subfolders',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'URL Exclusion Patterns',
		name: 'excludePatterns',
		type: 'string',
		typeOptions: {
			multipleValues: true,
		},
		default: [],
		placeholder: '**.pdf',
		description: 'Skip URLs matching these patterns. Examples:\n' +
			'• **.pdf - skip all PDF files in any folder\n' +
			'• **/admin/** - skip anything in admin folders\n' +
			'• example.com/temp/* - skip files in temp folder\n' +
			'• */draft-* - skip URLs containing draft- in the last segment',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Re-Set Crawler Tables',
		name: 'resetTables',
		type: 'boolean',
		default: false,
		description: 'Whether to reset (drop and recreate) all crawler-related tables before starting',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'WARNING: Only enable next parameter if crawling less than 30 pages as 1 HTML page can be as large as 10MB! A recommended way to get HTML is to use the dedicated Postgres node and get HTML from the crawler_queue table (status: completed, response_html column).',
		name: 'htmlWarning',
		type: 'notice',
		default: '',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Embed HTML of Scraped Pages in Node Output',
		name: 'includeHtml', 
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},

	// Scraping Engine Settings Group
	{
		displayName: 'Scraping Engine Settings',
		name: 'scrapingSettingsHeader',
		type: 'notice',
		default: '',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Engine Type',
		name: 'engine',
		type: 'options',
		options: [
			{
				name: 'Fast (No JS)',
				value: 'scrape',
				description: 'High-performance, no-JS endpoint. Performs raw network request with TLS fingerprint of a real browser.',
			},
			{
				name: 'Real Browser (With JS)',
				value: 'scrape-js',
				description: 'Real Chrome rendering with Javascript. Takes screenshots. 3x slower',
			},
		],
		default: 'scrape',
		description: 'Choose which scraping engine to use for crawling',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Headers',
		name: 'headers',
		type: 'string',
		typeOptions: {
			multipleValues: true,
			multipleValueButtonText: 'Add Header',
		},
		default: [],
		placeholder: 'X-Header: some-random-header',
		description: 'Custom request headers (one per line: "HeaderName: value"). Adding User-Agent and other basic headers is ' +
			'NOT recommended, they will be added automatically by ScrapeNinja.',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Retry Count',
		name: 'retryNum',
		type: 'number',
		default: 1,
		description: 'Number of retry attempts if certain conditions fail',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Geo Location',
		name: 'geo',
		type: 'options',
		options: [
			{
				name: '[Custom or Premium Proxy]',
				value: '_custom',
			},
			{
				name: 'Australia',
				value: 'au',
			},
			{
				name: 'Brazil',
				value: 'br',
			},
			{
				name: 'Europe',
				value: 'eu',
			},
			{
				name: 'France',
				value: 'fr',
			},
			{
				name: 'Germany',
				value: 'de',
			},
			{
				name: 'United States',
				value: 'us',
			},
		],
		default: 'us',
		description: 'Proxy geo location or custom proxy',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Custom Proxy URL',
		name: 'proxy',
		type: 'string',
		default: '',
		description: 'Premium or custom proxy URL',
		placeholder: 'http://user:pass@host:port',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
				geo: ['_custom'],
			},
		},
	},
	{
		displayName: 'Text Not Expected',
		name: 'textNotExpected',
		type: 'string',
		typeOptions: {
			multipleValues: true,
			multipleValueButtonText: 'Add Text',
		},
		default: [],
		description: 'Array of text patterns that, if found, will trigger a retry with another proxy',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Status Not Expected',
		name: 'statusNotExpected',
		type: 'number',
		typeOptions: {
			multipleValues: true,
			multipleValueButtonText: 'Add Status Code',
		},
		// eslint-disable-next-line
		default: [],
		description: 'HTTP statuses that will trigger a retry with another proxy',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Follow Redirects',
		name: 'followRedirects',
		type: 'boolean',
		default: true,
		description: 'Whether to follow HTTP redirects',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
				engine: ['scrape'],
			},
		},
	},
	{
		displayName: 'Timeout (Seconds)',
		name: 'timeout',
		type: 'number',
		default: 10,
		description: 'Timeout per attempt (in seconds)',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
				engine: ['scrape'],
			},
		},
	},
	{
		displayName: 'Timeout (Seconds)',
		name: 'timeoutJs',
		type: 'number',
		default: 16,
		description: 'Timeout per attempt (in seconds) for JS-based scraping',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
				engine: ['scrape-js'],
			},
		},
	},
	// JS-specific options
	{
		displayName: 'Wait For Selector',
		name: 'waitForSelector',
		type: 'string',
		default: '',
		description: 'CSS selector to wait for before considering page loaded',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
				engine: ['scrape-js'],
			},
		},
	},
	{
		displayName: 'Block Images',
		name: 'blockImages',
		type: 'boolean',
		default: false,
		description: 'Whether to block images in real Chrome to speed up loading',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
				engine: ['scrape-js'],
			},
		},
	},
	{
		displayName: 'Block Media (CSS, Fonts)',
		name: 'blockMedia',
		type: 'boolean',
		default: false,
		description: 'Whether to block CSS/fonts in real Chrome to speed up loading',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
				engine: ['scrape-js'],
			},
		},
	},
	{
		displayName: 'Post-Load Wait Time',
		name: 'postWaitTime',
		type: 'number',
		typeOptions: {
			minValue: 0,
			maxValue: 12,
		},
		default: 0,
		placeholder: '5',
		description: 'Wait for specified amount of seconds after page load (from 1 to 12s)',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
				engine: ['scrape-js'],
			},
		},
	},
];

const createTablesSQL = `
-- Create crawler runs table
CREATE TABLE IF NOT EXISTS crawler_runs (
	id SERIAL PRIMARY KEY,
	start_url TEXT NOT NULL,
	status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'canceled')),
	max_depth INTEGER NOT NULL,
	max_pages INTEGER NOT NULL,
	concurrency INTEGER NOT NULL DEFAULT 1,
	include_patterns TEXT[] DEFAULT '{}',
	exclude_patterns TEXT[] DEFAULT '{}',
	crawl_external BOOLEAN DEFAULT false,
	settings JSONB NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
	completed_at TIMESTAMP WITH TIME ZONE
);

-- Create crawler queue table
CREATE TABLE IF NOT EXISTS crawler_queue (
	id SERIAL PRIMARY KEY,
	run_id INTEGER NOT NULL REFERENCES crawler_runs(id),
	url TEXT NOT NULL,
	status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'canceled')),
	parent_url TEXT,
	depth INTEGER NOT NULL DEFAULT 0,
	error TEXT,
	response_html TEXT,
	response_status_code INTEGER,
	response_final_url TEXT,
	page_title VARCHAR(250),
	created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create crawler logs table
CREATE TABLE IF NOT EXISTS crawler_logs (
	id SERIAL PRIMARY KEY,
	run_id INTEGER NOT NULL REFERENCES crawler_runs(id),
	level VARCHAR(10) NOT NULL,
	message TEXT NOT NULL,
	metadata JSONB,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_crawler_queue_run_id ON crawler_queue(run_id);
CREATE INDEX IF NOT EXISTS idx_crawler_queue_status ON crawler_queue(status);
CREATE INDEX IF NOT EXISTS idx_crawler_queue_url_dedup ON crawler_queue(run_id, url);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_run_id ON crawler_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_crawler_logs_created_at ON crawler_logs(created_at);
`;

const dropTablesSQL = `
DROP TABLE IF EXISTS crawler_logs CASCADE;
DROP TABLE IF EXISTS crawler_queue CASCADE;
DROP TABLE IF EXISTS crawler_runs CASCADE;
`;

async function getCrawlerResults(
	db: IDatabase<any>,
	runId: number,
	includeHtml: boolean,
): Promise<{
	run: any;
	stats: {
		total_pages: number;
		pending_pages: number;
		completed_pages: number;
		failed_pages: number;
		canceled_pages: number;
		duration_seconds: number;
	};
	pages: any[];
	logs: any[];
}> {
	// Get run information
	const runInfo = await db.one(
		'SELECT *, EXTRACT(EPOCH FROM (completed_at - created_at)) as duration_seconds FROM crawler_runs WHERE id = $1',
		[runId],
	);

	// Get all logs for the run, ordered by creation time
	const logs = await db.manyOrNone(
		'SELECT level, message, metadata, created_at FROM crawler_logs WHERE run_id = $1 ORDER BY id ASC',
		[runId],
	);

	// Get all completed pages (excluding HTML if not requested)
	const pagesQuery = includeHtml
		? `SELECT * FROM crawler_queue WHERE run_id = $1`
		: `SELECT id, run_id, url, status, parent_url, depth, error, response_status_code, response_final_url, created_at, updated_at 
		   FROM crawler_queue WHERE run_id = $1`;

	const pages = await db.manyOrNone(pagesQuery, [runId]);

	// Get statistics
	const stats = await db.one<{ total: string, pending: string, completed: string, failed: string, canceled: string }>(
		`SELECT 
			COUNT(*) as total,
			COUNT(*) FILTER (WHERE status = 'pending') as pending,
			COUNT(*) FILTER (WHERE status = 'completed') as completed,
			COUNT(*) FILTER (WHERE status = 'failed') as failed,
			COUNT(*) FILTER (WHERE status = 'canceled') as canceled
		FROM crawler_queue 
		WHERE run_id = $1`,
		[runId],
	);

	return {
		run: runInfo,
		stats: {
			total_pages: parseInt(stats.total),
			pending_pages: parseInt(stats.pending),
			completed_pages: parseInt(stats.completed),
			failed_pages: parseInt(stats.failed),
			canceled_pages: parseInt(stats.canceled),
			duration_seconds: Math.round(runInfo.duration_seconds || 0),
		},
		pages,
		logs,
	};
}

async function waitForCrawlerToFinish(db: IDatabase<any>, runId: number): Promise<void> {
	await new Promise<void>((resolve) => {
		const checkInterval = setInterval(async () => {
			const status = await db.oneOrNone<{ status: string }>(
				'SELECT status FROM crawler_runs WHERE id = $1',
				[runId],
			);

			if (status && ['completed', 'failed', 'canceled'].includes(status.status)) {
				// Set completed_at when the run finishes
				await db.none(
					'UPDATE crawler_runs SET completed_at = CURRENT_TIMESTAMP WHERE id = $1 AND completed_at IS NULL',
					[runId],
				);
				clearInterval(checkInterval);
				resolve();
			}
		}, 1000);
	});
}

export async function executeCrawler(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
	itemIndex: number,
): Promise<INodeExecutionData> {
	const operation = this.getNodeParameter('operation', itemIndex) as string;
	const credentials = await this.getCredentials('postgres');

	this.logger.info('Initializing crawler node', { operation });

	const pgp = pgPromise();
	const db = pgp({
		host: credentials.host as string,
		port: credentials.port as number,
		user: credentials.user as string,
		password: credentials.password as string,
		database: credentials.database as string,
		ssl: !!(credentials.ssl as boolean),
	});

	try {
		this.logger.debug('Creating database tables if they don\'t exist');
		// Create tables if they don't exist
		await db.none(`
			CREATE TABLE IF NOT EXISTS crawler_runs (
				id SERIAL PRIMARY KEY,
				start_url TEXT NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'canceled')),
				max_depth INTEGER NOT NULL,
				max_pages INTEGER NOT NULL,
				concurrency INTEGER NOT NULL DEFAULT 1,
				include_patterns TEXT[] DEFAULT '{}',
				exclude_patterns TEXT[] DEFAULT '{}',
				crawl_external BOOLEAN DEFAULT false,
				settings JSONB NOT NULL,
				created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
				completed_at TIMESTAMP WITH TIME ZONE
			);

			CREATE TABLE IF NOT EXISTS crawler_queue (
				id SERIAL PRIMARY KEY,
				run_id INTEGER REFERENCES crawler_runs(id),
				url TEXT NOT NULL,
				status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'canceled')),
				parent_url TEXT,
				depth INTEGER NOT NULL DEFAULT 0,
				created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
				error TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_crawler_queue_status ON crawler_queue(status);
			CREATE INDEX IF NOT EXISTS idx_crawler_queue_run_id ON crawler_queue(run_id);
		`);

		let result: INodeExecutionData;

		if (operation === 'crawler-start') {
			const resetTables = this.getNodeParameter('resetTables', itemIndex, false) as boolean;
			const startUrl = this.getNodeParameter('startUrl', itemIndex) as string;
			const maxDepth = this.getNodeParameter('maxDepth', itemIndex) as number;
			const maxPages = this.getNodeParameter('maxPages', itemIndex) as number;
			const includePatterns = this.getNodeParameter('includePatterns', itemIndex) as string[];
			const excludePatterns = this.getNodeParameter('excludePatterns', itemIndex) as string[];
			const crawlExternal = this.getNodeParameter('crawlExternal', itemIndex, false) as boolean;

			// Get scraping options
			const engine = this.getNodeParameter('engine', itemIndex) as string;
			const headers = this.getNodeParameter('headers', itemIndex, []) as string[];
			const retryNum = this.getNodeParameter('retryNum', itemIndex, 1) as number;
			const geo = this.getNodeParameter('geo', itemIndex, 'us') as string;
			const proxy = geo === '_custom' ? this.getNodeParameter('proxy', itemIndex, '') as string : undefined;
			const textNotExpected = this.getNodeParameter('textNotExpected', itemIndex, []) as string[];
			const statusNotExpected = this.getNodeParameter('statusNotExpected', itemIndex, []) as number[];

			// Engine-specific options
			const followRedirects = engine === 'scrape' ? this.getNodeParameter('followRedirects', itemIndex, true) as boolean : undefined;
			const timeout = engine === 'scrape' ? this.getNodeParameter('timeout', itemIndex, 10) as number : undefined;
			const timeoutJs = engine === 'scrape-js' ? this.getNodeParameter('timeoutJs', itemIndex, 16) as number : undefined;
			const waitForSelector = engine === 'scrape-js' ? this.getNodeParameter('waitForSelector', itemIndex, '') as string : undefined;
			const blockImages = engine === 'scrape-js' ? this.getNodeParameter('blockImages', itemIndex, false) as boolean : undefined;
			const blockMedia = engine === 'scrape-js' ? this.getNodeParameter('blockMedia', itemIndex, false) as boolean : undefined;
			const postWaitTime = engine === 'scrape-js' ? this.getNodeParameter('postWaitTime', itemIndex, 0) as number : undefined;

			const concurrency = this.getNodeParameter('concurrency', itemIndex, 1) as number;

			if (resetTables) {
				// Drop all tables and their dependencies
				await db.none(dropTablesSQL);
			}

			// Create tables (if they don't exist)
			await db.none(createTablesSQL);

			this.logger.info('Starting new crawler run', { startUrl, maxDepth, maxPages });

			// Create new crawl run with all options
			const run = await db.tx<ICrawlerRun>(async (t: ITask<any>) => {
				const settings = {
					engine,
					headers,
					retryNum,
					geo,
					proxy,
					textNotExpected,
					statusNotExpected,
					followRedirects,
					timeout,
					timeoutJs,
					waitForSelector,
					blockImages,
					blockMedia,
					postWaitTime,
				};

				const runResult = await t.one<ICrawlerRun>(
					`INSERT INTO crawler_runs (
						start_url, status, max_depth, max_pages, 
						concurrency, include_patterns, exclude_patterns, crawl_external,
						settings
					) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
					[
						startUrl, 'running', maxDepth, maxPages,
						concurrency, includePatterns, excludePatterns, crawlExternal,
						settings,
					],
				);

				this.logger.debug('Created new crawler run', { 
					runId: runResult.id, 
					startUrl,
					maxDepth,
					maxPages,
					includePatterns,
					excludePatterns,
					crawlExternal,
					settings,
				});

				await t.none(
					'INSERT INTO crawler_queue (run_id, url, status, parent_url, depth) VALUES ($1, $2, $3, $4, $5)',
					[runResult.id, startUrl, 'pending', null, 0],
				);

				return runResult;
			});

			// Pass all options to processCrawlerQueue
			await processCrawlerQueue.call(
				this,
				db,
				run.id,
				run.max_depth,
				run.max_pages,
				run.include_patterns,
				run.exclude_patterns,
				run.crawl_external,
				run.settings,
			);

			// Wait for crawler to finish
			await waitForCrawlerToFinish(db, run.id);

			// Get complete run information
			const includeHtml = this.getNodeParameter('includeHtml', itemIndex, false) as boolean;
			const results = await getCrawlerResults(db, run.id, includeHtml);
			result = { json: results };
		} else {
			throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
		}

		this.logger.debug('Closing database connection');
		await pgp.end();
		return result;
	} catch (error) {
		this.logger.error('Error in crawler node', { error: error.message, stack: error.stack });
		await pgp.end();
		throw new NodeOperationError(this.getNode(), error as Error);
	}
} 