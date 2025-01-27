import type { INodeProperties } from 'n8n-workflow';
import type { IExecuteFunctions, INodeExecutionData, IHttpRequestMethods, IDataObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export const scrapeProperties: INodeProperties[] = [
	{
		displayName: 'URL to Scrape',
		name: 'url',
		type: 'string',
		default: '',
		placeholder: 'https://example.com',
		description: 'URL to scrape. Use https://myip.scrapeninja.net/ to see the IP address and geo location of your request. Use https://apiroad.net/post-json.php to test what headers you send and what IP address you get', // eslint-disable-line
		required: true,
		displayOptions: {
			show: {
				operation: ['scrape', 'scrape-js'],
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
			'NOT recommended, they will be added automatically by ScrapeNinja. ' +
			'If you want to see which headers ScrapeNinja adds by default, try to scrape https://apiroad.net/post-json.php',
		displayOptions: {
			show: {
				operation: ['scrape', 'scrape-js'],
			},
		},
	},
	{
		displayName: 'Retry Count',
		name: 'retryNum',
		type: 'number',
		default: 1,
		description: 'Number of retry attempts if certain conditions fail (some HTTP failure, or "Text Not Expected" occurence, or "Status Not Expected" occurence)',
		displayOptions: {
			show: {
				operation: ['scrape', 'scrape-js'],
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
		description: 'Proxy geo location or custom proxy. Note that each attempt will be made from a different IP address if using "Geo" option.',
		displayOptions: {
			show: {
				operation: ['scrape', 'scrape-js'],
			},
		},
	},
	{
		displayName: 'Custom Proxy URL',
		name: 'proxy',
		type: 'string',
		default: '',
		description: 'Premium or custom proxy URL. See proxy setup guide at https://scrapeninja.net/docs/proxy-setup/.',
		placeholder: 'http://user:pass@host:port',
		displayOptions: {
			show: {
				operation: ['scrape', 'scrape-js'],
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
				operation: ['scrape', 'scrape-js'],
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
		default: [], // eslint-disable-line
		description: 'HTTP statuses that will trigger a retry with another proxy. By default, 403 and 502 are included in retries.',
		displayOptions: {
			show: {
				operation: ['scrape', 'scrape-js'],
			},
		},
	},
	{
		displayName: 'Extractor (Custom JS)',
		name: 'extractor',
		type: 'string',
		typeOptions: {
			rows: 4,
		},
		default: '',
		placeholder: `function extract(input, cheerio) {
    let $ = cheerio.load(input);
    return {
        title: $('h1:first').text().trim()
    };
}`,
		description: 'Custom JS function for extracting data from HTML. See docs and playground at https://scrapeninja.net/docs/js-extractor/ The function receives page HTML as "input" and Cheerio parser as "cheerio". Must return a JSON object.',
		noDataExpression: true,
		displayOptions: {
			show: {
				operation: ['scrape', 'scrape-js'],
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
				operation: ['scrape'],
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
				operation: ['scrape'],
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
				operation: ['scrape-js'],
			},
		},
	},
];

export const scrapeJsProperties: INodeProperties[] = [
	{
		displayName: 'Wait For Selector',
		name: 'waitForSelector',
		type: 'string',
		default: '',
		description: 'CSS selector to wait for before considering page loaded',
		displayOptions: {
			show: {
				operation: ['scrape-js'],
			},
		},
	},
	{
		displayName: 'Dump Iframe',
		name: 'dumpIframe',
		type: 'string',
		default: '',
		description: 'Iframe name to dump. If provided, we wait for this iframe to appear in DOM.',
		displayOptions: {
			show: {
				operation: ['scrape-js'],
			},
		},
	},
	{
		displayName: 'Wait For Selector in Iframe',
		name: 'waitForSelectorIframe',
		type: 'string',
		default: '',
		description: 'CSS selector to wait for inside the iframe (if "dumpIframe" is set)',
		displayOptions: {
			show: {
				operation: ['scrape-js'],
			},
		},
	},
	{
		displayName: 'Extractor Target Iframe',
		name: 'extractorTargetIframe',
		type: 'boolean',
		default: false,
		description: 'Whether to run the custom extractor on iframe HTML instead of the main page',
		displayOptions: {
			show: {
				operation: ['scrape-js'],
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
				operation: ['scrape-js'],
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
				operation: ['scrape-js'],
			},
		},
	},
	{
		displayName: 'Screenshot',
		name: 'screenshot',
		type: 'boolean',
		default: false,
		description: 'Whether to take a screenshot of the page. Slower if true.',
		displayOptions: {
			show: {
				operation: ['scrape-js'],
			},
		},
	},
	{
		displayName: 'Catch Ajax Headers URL Mask',
		name: 'catchAjaxHeadersUrlMask',
		type: 'string',
		default: '',
		description: 'If set, tries to catch/dump specific XHR requests/responses that match this mask',
		displayOptions: {
			show: {
				operation: ['scrape-js'],
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
		description: 'Wait for specified amount of seconds after page load (from 1 to 12s). Use this only if ScrapeNinja failed to wait for required page elements automatically.',
		displayOptions: {
			show: {
				operation: ['scrape-js'],
			},
		},
	},
	{
		displayName: 'Viewport Settings (JSON)',
		name: 'viewport',
		type: 'string',
		typeOptions: {
			rows: 4,
		},
		default: '',
		placeholder: `{
  "width": 1920,
  "height": 1080,
  "deviceScaleFactor": 1,
  "isMobile": false,
  "hasTouch": false,
  "isLandscape": false
}`,
		description: 'Advanced. Set custom viewport size. By default, viewport size is 1920x1080. Provide a valid JSON object with viewport settings.',
		displayOptions: {
			show: {
				operation: ['scrape-js'],
			},
		},
	},
];

export async function executeScrape(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
	i: number,
	operation: string,
): Promise<INodeExecutionData> {
	const credentials = await this.getCredentials('scrapeNinjaApi') as IDataObject;
	if (!credentials?.apiKey) {
		throw new NodeOperationError(this.getNode(), 'No ScrapeNinja API Key found in credentials!');
	}

	const url = this.getNodeParameter('url', i) as string;
	const customHeaders = this.getNodeParameter('headers', i, []) as string[];
	const retryNum = this.getNodeParameter('retryNum', i, 1) as number;
	const geo = this.getNodeParameter('geo', i, 'us') as string;
	const proxy = geo === '_custom' ? this.getNodeParameter('proxy', i, '') as string : '';
	const textNotExpected = this.getNodeParameter('textNotExpected', i, []) as string[];
	const statusNotExpected = this.getNodeParameter('statusNotExpected', i, []) as number[];
	const extractor = this.getNodeParameter('extractor', i, '') as string;

	const timeout = operation === 'scrape' 
		? this.getNodeParameter('timeout', i, 10) as number
		: this.getNodeParameter('timeoutJs', i, 16) as number;

	// Build request body
	const body: Record<string, any> = {
		url,
		headers: customHeaders,
		retryNum,
		textNotExpected,
		extractor,
		timeout,
	};

	// Add statusNotExpected only if not empty
	if (statusNotExpected.length > 0) {
		body.statusNotExpected = statusNotExpected;
	}

	// Add geo only if not using custom proxy
	if (geo !== '_custom') {
		body.geo = geo;
	}

	// Add proxy if using custom proxy and it's not empty
	if (geo === '_custom' && proxy) {
		body.proxy = proxy;
	}

	// Additional fields for /scrape
	if (operation === 'scrape') {
		const followRedirects = this.getNodeParameter('followRedirects', i, true) as boolean;
		body.followRedirects = followRedirects ? 1 : 0;
	}

	// Additional fields for /scrape-js
	if (operation === 'scrape-js') {
		body.waitForSelector = this.getNodeParameter('waitForSelector', i, '') as string;
		body.dumpIframe = this.getNodeParameter('dumpIframe', i, '') as string;
		body.waitForSelectorIframe = this.getNodeParameter('waitForSelectorIframe', i, '') as string;
		body.extractorTargetIframe = this.getNodeParameter('extractorTargetIframe', i, false) as boolean;
		body.blockImages = this.getNodeParameter('blockImages', i, false) as boolean;
		body.blockMedia = this.getNodeParameter('blockMedia', i, false) as boolean;
		body.screenshot = this.getNodeParameter('screenshot', i, false) as boolean;
		body.catchAjaxHeadersUrlMask = this.getNodeParameter('catchAjaxHeadersUrlMask', i, '') as string;
		
		// Add postWaitTime only if greater than 0
		const postWaitTime = this.getNodeParameter('postWaitTime', i, 0) as number;
		if (postWaitTime > 0) {
			body.postWaitTime = postWaitTime;
		}

		// Add viewport if it's set and valid JSON
		const viewportString = this.getNodeParameter('viewport', i, '') as string;
		if (viewportString.trim() !== '') {
			try {
				const viewport = JSON.parse(viewportString);
				if (typeof viewport !== 'object' || viewport === null) {
					throw new NodeOperationError(this.getNode(), 'Viewport must be a valid JSON object', {
						itemIndex: i,
					});
				}
				body.viewport = viewport;
			} catch (e) {
				throw new NodeOperationError(this.getNode(), 'Invalid viewport JSON provided', {
					itemIndex: i,
				});
			}
		}
	}

	// Decide endpoint based on marketplace
	const marketplace = (credentials as any).marketplace || 'rapidapi';
	const endpoint = operation === 'scrape'
		? marketplace === 'rapidapi' 
			? 'https://scrapeninja.p.rapidapi.com/scrape'
			: 'https://scrapeninja.apiroad.net/scrape'
		: marketplace === 'rapidapi'
			? 'https://scrapeninja.p.rapidapi.com/scrape-js'
			: 'https://scrapeninja.apiroad.net/scrape-js';

	// Prepare headers based on marketplace
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};

	if (marketplace === 'rapidapi') {
		headers['X-RapidAPI-Key'] = credentials.apiKey.toString();
		headers['X-RapidAPI-Host'] = 'scrapeninja.p.rapidapi.com';
	} else {
		headers['X-Apiroad-Key'] = credentials.apiKey.toString();
	}

	// Prepare request
	const requestOptions = {
		method: 'POST' as IHttpRequestMethods,
		url: endpoint,
		headers,
		body,
		json: true,
		resolveWithFullResponse: true,
		simple: false,
	};

	try {
		const response = await this.helpers.httpRequest(requestOptions);
		return {
			json: response,
		};
	} catch (error) {
		if (error.response) {
			if (error.response.status === 403) {
				const marketplaceName = marketplace === 'rapidapi' ? 'RapidAPI' : 'APIRoad';
				throw new NodeApiError(this.getNode(), error, {
					message: `${marketplaceName} returned 403 Forbidden - This usually means your API key is invalid or has expired`,
					description: JSON.stringify(error.response.data),
				});
			}
			throw new NodeApiError(this.getNode(), error);
		}
		throw error;
	}
} 