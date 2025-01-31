import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import pgPromise, { ITask } from 'pg-promise';
import { processCrawlerQueue } from './CrawlerExecute';

interface ICrawlerRun {
	id: number;
	start_url: string;
	status: 'running' | 'paused' | 'completed' | 'failed' | 'canceled';
	max_depth: number;
	max_pages: number;
	include_patterns: string[];
	exclude_patterns: string[];
	crawl_external: boolean;
	created_at: Date;
	updated_at: Date;
}

export const crawlerProperties: INodeProperties[] = [
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
		displayName: 'Run ID',
		name: 'runId',
		type: 'number',
		default: 0,
		required: true,
		displayOptions: {
			show: {
				operation: ['crawler-resume', 'crawler-pause'],
			},
		},
		description: 'ID of the crawl run to resume or pause',
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
		displayName: 'URL Inclusion Patterns',
		name: 'includePatterns',
		type: 'string',
		typeOptions: {
			multipleValues: true,
		},
		default: [],
		description: 'Only crawl URLs matching these patterns (e.g., "*.example.com/*", "/products/*")',
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
		description: 'Skip URLs matching these patterns (e.g., "*.md", "*/base-docs/*")',
		displayOptions: {
			show: {
				operation: ['crawler-start'],
			},
		},
	},
	{
		displayName: 'Re-set Crawler Tables',
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
];

const createTablesSQL = `
-- Create crawler runs table
CREATE TABLE IF NOT EXISTS crawler_runs (
	id SERIAL PRIMARY KEY,
	start_url TEXT NOT NULL,
	status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'canceled')),
	max_depth INTEGER NOT NULL,
	max_pages INTEGER NOT NULL,
	include_patterns TEXT[] DEFAULT '{}',
	exclude_patterns TEXT[] DEFAULT '{}',
	crawl_external BOOLEAN DEFAULT false,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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
				include_patterns TEXT[] DEFAULT '{}',
				exclude_patterns TEXT[] DEFAULT '{}',
				crawl_external BOOLEAN DEFAULT false,
				created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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

			if (resetTables) {
				// Drop all tables and their dependencies
				await db.none(dropTablesSQL);
			}

			// Create tables (if they don't exist)
			await db.none(createTablesSQL);

			this.logger.info('Starting new crawler run', { startUrl, maxDepth, maxPages });

			// Create new crawl run and add initial URL in a transaction
			const run = await db.tx<ICrawlerRun>(async (t: ITask<any>) => {
				const runResult = await t.one<ICrawlerRun>(
					`INSERT INTO crawler_runs (
						start_url, 
						status, 
						max_depth, 
						max_pages, 
						include_patterns, 
						exclude_patterns,
						crawl_external
					) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
					[
						startUrl,
						'running',
						maxDepth,
						maxPages,
						includePatterns,
						excludePatterns,
						crawlExternal,
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
				});

				await t.none(
					'INSERT INTO crawler_queue (run_id, url, status, parent_url, depth) VALUES ($1, $2, $3, $4, $5)',
					[runResult.id, startUrl, 'pending', null, 0],
				);

				return runResult;
			});

			// Start processing queue
			await processCrawlerQueue.call(
				this,
				db,
				run.id,
				run.max_depth,
				run.max_pages,
				run.include_patterns,
				run.exclude_patterns,
				run.crawl_external,
			);

			result = { json: { runId: run.id, status: 'started', startUrl } };
		} else if (operation === 'crawler-resume') {
			const runId = this.getNodeParameter('runId', itemIndex) as number;

			this.logger.info('Resuming crawler run', { runId });

			// Update run status and verify it exists in a transaction
			const run = await db.tx<ICrawlerRun>(async (t: ITask<any>) => {
				const runResult = await t.oneOrNone<ICrawlerRun>(
					'SELECT * FROM crawler_runs WHERE id = $1',
					[runId],
				);

				if (!runResult) {
					this.logger.error('Run not found', { runId });
					throw new NodeOperationError(this.getNode(), `Run ID ${runId} not found`);
				}

				this.logger.debug('Updating run status to running', { runId });
				await t.none(
					'UPDATE crawler_runs SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
					['running', runId],
				);

				return runResult;
			});

			const maxDepth = this.getNodeParameter('maxDepth', itemIndex, 3) as number;
			const maxPages = this.getNodeParameter('maxPages', itemIndex, 100) as number;
			const includePatterns = this.getNodeParameter('includePatterns', itemIndex, []) as string[];
			const excludePatterns = this.getNodeParameter('excludePatterns', itemIndex, []) as string[];

			// Resume processing queue
			await processCrawlerQueue.call(this, db, run.id, maxDepth, maxPages, includePatterns, excludePatterns);

			result = { json: { runId, status: 'resumed' } };
		} else if (operation === 'crawler-pause') {
			const runId = this.getNodeParameter('runId', itemIndex) as number;

			this.logger.info('Pausing crawler run', { runId });

			// Update run status
			await db.none(
				'UPDATE crawler_runs SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
				['paused', runId],
			);

			result = { json: { runId, status: 'paused' } };
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