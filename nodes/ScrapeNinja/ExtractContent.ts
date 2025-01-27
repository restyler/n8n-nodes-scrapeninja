import type { INodeProperties } from 'n8n-workflow';
import { Readability } from '@mozilla/readability';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { JSDOM } from 'jsdom';
import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

export const extractContentProperties: INodeProperties[] = [
	{
		displayName: 'HTML',
		name: 'html',
		type: 'string',
		default: '',
		description: 'HTML content to extract main content from',
		required: true,
		displayOptions: {
			show: {
				operation: ['extract-content'],
			},
		},
	},
	{
		displayName: 'Output as Markdown',
		name: 'outputMarkdown',
		type: 'boolean',
		default: false,
		description: 'Whether to convert the extracted HTML content to Markdown format',
		displayOptions: {
			show: {
				operation: ['extract-content'],
			},
		},
	},
];

export async function executeExtractContent(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
	i: number,
): Promise<INodeExecutionData> {
	const html = this.getNodeParameter('html', i) as string;
	const outputMarkdown = this.getNodeParameter('outputMarkdown', i, false) as boolean;

	// Create virtual DOM
	const dom = new JSDOM(html);
	const reader = new Readability(dom.window.document);
	const article = reader.parse();

	if (!article) {
		throw new Error('Failed to extract content from the HTML');
	}

	// If markdown output is requested, only transform the content field
	if (outputMarkdown) {
		return {
			json: {
				...article,
				content: NodeHtmlMarkdown.translate(article.content || ''),
			},
		};
	}

	// Otherwise return the full article object as-is
	return {
		json: article,
	};
} 