import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { extractContentProperties, executeExtractContent } from './ExtractContent';
import { scrapeProperties, scrapeJsProperties, executeScrape } from './ScrapeOperations';

export class ScrapeNinja implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ScrapeNinja',
		name: 'scrapeNinja',
		icon: 'file:ScrapeNinja.svg',
		group: ['transform'],
		version: 1,
		description: 'Consume ScrapeNinja Web Scraping API - See full documentation at https://scrapeninja.net/docs/',
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		defaults: {
			name: 'ScrapeNinja',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'scrapeNinjaApi',
				required: false,
				displayOptions: {
					show: {
						operation: ['scrape', 'scrape-js'],
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
			// Scraping operation parameters
			...scrapeProperties,
			// Additional parameters for scrape-js operation
			...scrapeJsProperties,
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