import type { INodeProperties } from 'n8n-workflow';
import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import * as cheerio from 'cheerio';
import { NodeVM } from '@n8n/vm2';

export const extractCustomProperties: INodeProperties[] = [
	{
		displayName: 'HTML',
		name: 'html',
		type: 'string',
		default: '',
		description: 'HTML content to extract data from',
		required: true,
		displayOptions: {
			show: {
				operation: ['extract-custom'],
			},
		},
	},
	{
		displayName: 'Extraction Function',
		name: 'extractionFunction',
		type: 'string',
		typeOptions: {
			rows: 15,
		},
		default: 'function extract(html, cheerioInstance) {\n  const $ = cheerioInstance.load(html);\n  return {\n    title: $("h1").text().trim()\n  };\n}',
		description: 'JavaScript function that will be executed to extract data. The function receives HTML content and cheerio instance as arguments.',
		required: true,
		displayOptions: {
			show: {
				operation: ['extract-custom'],
			},
		},
	},
];

export async function executeExtractCustom(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
	i: number,
): Promise<INodeExecutionData> {
	const html = this.getNodeParameter('html', i) as string;
	let extractionFunction = this.getNodeParameter('extractionFunction', i) as string;

	// Remove markdown code block markers if present
	extractionFunction = extractionFunction
		.replace(/^```(javascript|js)?\n/, '') // Remove opening ```javascript or ```js
		.replace(/^```\n/, '') // Remove opening ``` without language
		.replace(/\n```$/, '') // Remove trailing ```
		.trim();

	// Create a new VM instance with access to cheerio
	const vm = new NodeVM({
		console: 'inherit',
		sandbox: {},
		require: {
			external: false,
			builtin: ['*'],
			root: './',
		},
	});

	try {
		// Wrap the extraction function in a module exports and pass cheerio directly
		const wrappedCode = `
			module.exports = function(html, cheerioInstance) {
				const extractFn = ${extractionFunction};
				return extractFn(html, cheerioInstance);
			}
		`;

		// Execute the code in VM2
		const extractFn = vm.run(wrappedCode);

		// Execute the extracted function with our parameters
		const result = extractFn(html, cheerio);

		return {
			json: result,
		};
	} catch (error) {
		throw new Error(`Failed to execute extraction function: ${error.message}`);
	}
} 