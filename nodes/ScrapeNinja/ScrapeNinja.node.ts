import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError, NodeConnectionType } from 'n8n-workflow';
import { extractContentProperties, executeExtractContent } from './ExtractContent';
import { scrapeProperties, scrapeJsProperties, executeScrape } from './ScrapeOperations';
import { cleanupHtmlProperties, executeCleanupHtml } from './CleanupHtml';
import { extractCustomProperties, executeExtractCustom } from './ExtractCustom';
import { crawlerProperties, executeCrawler } from './CrawlerOperations';

export class ScrapeNinja implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ScrapeNinja',
		name: 'scrapeNinja',
		icon: 'file:ScrapeNinja.svg',
		group: ['transform'],
		version: 1,
		description: 'Consume ScrapeNinja Web Scraping API - See full documentation at https://scrapeninja.net/docs/',
		subtitle: '={{ $parameter["operation"] }}',
		defaults: {
			name: 'ScrapeNinja',
		},
		inputs: [{
			type: NodeConnectionType.Main,
		}],
		outputs: [{
			type: NodeConnectionType.Main,
		}],
		credentials: [
			{
				name: 'scrapeNinjaApi',
				required: false,
				displayOptions: {
					show: {
						operation: ['scrape', 'scrape-js', 'crawler-start', 'crawler-resume'],
					},
				},
			},
			{
				name: 'postgres',
				required: true,
				displayOptions: {
					show: {
						operation: ['crawler-start', 'crawler-resume', 'crawler-pause'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
                    {
                        name: 'Clean Up HTML',
                        value: 'cleanup-html',
                        description: 'Clean up and compress HTML content',
                        action: 'Clean up HTML content',
                    },
                    {
                        name: 'Crawler: Pause',
                        value: 'crawler-pause',
                        description: 'Pause an active crawl',
                        action: 'Pause an active crawl',
                    },
                    {
                        name: 'Crawler: Resume',
                        value: 'crawler-resume',
                        description: 'Resume an existing crawl',
                        action: 'Resume an existing crawl',
                    },
                    {
                        name: 'Crawler: Start',
                        value: 'crawler-start',
                        description: 'Start a new crawling process',
                        action: 'Start a new crawling process',
                    },
                    {
                        name: 'Extract Custom',
                        value: 'extract-custom',
                        description: 'Extract data using custom javascript function',
                        action: 'Extract data using custom javascript',
                    },
                    {
                        name: 'Extract Primary Content',
                        value: 'extract-content',
                        description: 'Extract primary page content from HTML',
                        action: 'Extract primary content from HTML',
                    },
                    {
                        name: 'Scrape (No JS)',
                        value: 'scrape',
                        description: 'High-performance, no-JS endpoint. Performs raw network request with TLS fingerprint of a real browser.',
                        action: 'Scrape faster without javascript',
                    },
                    {
                        name: 'Scrape as a Real Browser',
                        value: 'scrape-js',
                        description: 'Real Chrome rendering with Javascript. Takes screenshots. 3x slower',
                        action: 'Scrape slower with real browser',
                    },
                ],
				default: 'scrape',
				description: 'Choose which endpoint to call',
			},
			// Extract Content operation parameters
			...extractContentProperties,
			// Extract Custom operation parameters
			...extractCustomProperties,
			// Cleanup HTML operation parameters
			...cleanupHtmlProperties,
			// Scraping operation parameters
			...scrapeProperties,
			// Additional parameters for scrape-js operation
			...scrapeJsProperties,
			// Crawler operation parameters
			...crawlerProperties,
			{
				displayName: 'Crawl External URLs',
				name: 'crawlExternal',
				type: 'boolean',
				default: false,
				description: 'Whether to crawl URLs from different domains than the starting URL',
				displayOptions: {
					show: {
						operation: ['crawler'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;

				if (operation === 'extract-content') {
					const result = await executeExtractContent.call(this, items, i);
					returnData.push(result);
					continue;
				}

				if (operation === 'cleanup-html') {
					const result = await executeCleanupHtml.call(this, items, i);
					returnData.push(result);
					continue;
				}

				if (operation === 'extract-custom') {
					const result = await executeExtractCustom.call(this, items, i);
					returnData.push(result);
					continue;
				}

				if (operation.startsWith('crawler-')) {
					const result = await executeCrawler.call(this, items, i);
					returnData.push(result);
					continue;
				}

				const result = await executeScrape.call(this, items, i, operation);
				returnData.push(result);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error.message,
							details: error.response?.data || 'No additional details available',
						},
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error, {
					itemIndex: i,
				});
			}
		}

		return [returnData];
	}
} 