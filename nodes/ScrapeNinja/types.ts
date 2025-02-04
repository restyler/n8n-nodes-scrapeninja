export interface IScrapeSettings {
	engine: 'scrape' | 'scrape-js';
	headers: string[];
	retryNum: number;
	geo: string;
	proxy?: string;
	textNotExpected: string[];
	statusNotExpected: number[];
	followRedirects?: boolean;
	timeout?: number;
	timeoutJs?: number;
	waitForSelector?: string;
	blockImages?: boolean;
	blockMedia?: boolean;
	postWaitTime?: number;
} 