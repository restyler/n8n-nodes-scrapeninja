import type { INodeProperties } from 'n8n-workflow';
import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import * as cheerio from 'cheerio';

export const cleanupHtmlProperties: INodeProperties[] = [
	{
		displayName: 'HTML',
		name: 'html',
		type: 'string',
		default: '',
		description: 'HTML content to clean up',
		required: true,
		displayOptions: {
			show: {
				operation: ['cleanup-html'],
			},
		},
	},
	{
		displayName: 'XML Mode',
		name: 'xml',
		type: 'boolean',
		default: false,
		description: 'Whether to use XML parser mode (htmlparser2) instead of HTML mode',
		displayOptions: {
			show: {
				operation: ['cleanup-html'],
			},
		},
	},
	{
		displayName: 'Max Text Node Length',
		name: 'maxTextLength',
		type: 'number',
		default: 0,
		description: 'Maximum length of text nodes (0 means no trimming)',
		displayOptions: {
			show: {
				operation: ['cleanup-html'],
			},
		},
	},
	{
		displayName: 'URL Max Length',
		name: 'maxUrlLength',
		type: 'number',
		default: 0,
		description: 'Maximum length of URL attributes (0 means no trimming)',
		displayOptions: {
			show: {
				operation: ['cleanup-html'],
			},
		},
	},
	{
		displayName: 'Only Body Content',
		name: 'onlyBody',
		type: 'boolean',
		default: false,
		description: 'Whether to keep only the contents of the &lt;body&gt; tag',
		displayOptions: {
			show: {
				operation: ['cleanup-html'],
			},
		},
	},
	{
		displayName: 'Max Output Length',
		name: 'maxOutputLength',
		type: 'number',
		default: 0,
		description: 'Maximum length of the output HTML (0 means no limit)',
		displayOptions: {
			show: {
				operation: ['cleanup-html'],
			},
		},
	},
];

function trimText(text: string, maxLength: number): string {
    if (maxLength === 0 || text.length <= maxLength) {
        return text;
    }
    return text.substring(0, maxLength) + '…';
}

function trimUrl(url: string, maxLength: number): string {
    if (maxLength === 0 || url.length <= maxLength) {
        return url;
    }
    return url.substring(0, maxLength) + '…';
}

function trimAttrs($: cheerio.Root, maxUrlLength: number): void {
    $('*').each(function(this: cheerio.Element) {
        const attrs = $(this).attr();
        for (const attr in attrs) {
            if (Object.prototype.hasOwnProperty.call(attrs, attr)) {
                const attrValue = attrs[attr];
                if (attr === 'href' || attr === 'src' || attr.startsWith('data-')) {
                    $(this).attr(attr, trimUrl(attrValue, maxUrlLength));
                }
            }
        }
    });
}

function removeInlineJs($: cheerio.Root): void {
    $('*[onclick], *[onmouseover], *[onchange], *[onload]').removeAttr('onclick onmouseover onchange onload');
}

function trimWhitespace($: cheerio.Root): void {
    $('*').contents().filter(function(this: cheerio.Element) {
        return this.type === 'text';
    }).each(function(this: cheerio.Element) {
        let text = $(this).text();
        text = text.replace(/\\s{2,}/g, ' ').trim();
        $(this).replaceWith(text);
    });
}

function trimHtmlComments($: cheerio.Root): void {
    $('*').contents().filter(function(this: cheerio.Element) {
        return this.type === 'comment';
    }).each(function(this: cheerio.Element & { data?: string }) {
        const commentText = this.data;
        if (commentText && commentText.length > 30) {
            this.data = commentText.substring(0, 30) + '…';
        }
    });
}

function getStats(originalHtml: string, processedHtml: string): any {
    const compressionRatio = (originalHtml.length - processedHtml.length) / originalHtml.length;
    const stats = {
        inputLength: originalHtml.length,
        outputLength: processedHtml.length,
        compressionRatio: Number(compressionRatio.toFixed(4)),
        compressionRatioHuman: (compressionRatio * 100).toFixed(2) + '%',
        htmlElements: 0,
        maxNestingLevel: 0,
        nodesAtHalfDepth: 0
    };

    // Parse the processed HTML to get element stats
    const $ = cheerio.load(processedHtml);
    stats.htmlElements = $('*').length;

    // Calculate max nesting level and nodes at half depth
    let maxDepth = 0;
    $('*').each(function(this: cheerio.Element) {
        const depth = $(this).parents().length;
        maxDepth = Math.max(maxDepth, depth);
    });
    stats.maxNestingLevel = maxDepth;

    // Calculate nodes at 50% depth
    const halfDepth = Math.floor(maxDepth / 2);
    $('*').each(function(this: cheerio.Element) {
        if ($(this).parents().length === halfDepth) {
            stats.nodesAtHalfDepth++;
        }
    });

    return stats;
}

export async function executeCleanupHtml(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
	i: number,
): Promise<INodeExecutionData> {
	const html = this.getNodeParameter('html', i) as string;
	const maxTextLength = this.getNodeParameter('maxTextLength', i, 0) as number;
	const maxUrlLength = this.getNodeParameter('maxUrlLength', i, 0) as number;
	const onlyBody = this.getNodeParameter('onlyBody', i, false) as boolean;
	const maxOutputLength = this.getNodeParameter('maxOutputLength', i, 0) as number;
	const xml = this.getNodeParameter('xml', i, false) as boolean;

	// Load HTML into cheerio with XML mode setting
	const $ = cheerio.load(html, {
		xmlMode: xml,
		decodeEntities: true,
	});

	// Remove <style> and <script> tags
	$('style, script').remove();

	// Remove inline JavaScript
	removeInlineJs($);

	// Trim whitespace
	trimWhitespace($);

	// Trim URLs if maxUrlLength is set
	if (maxUrlLength > 0) {
		trimAttrs($, maxUrlLength);
	}

	// Trim text nodes if maxTextLength is set
	if (maxTextLength > 0) {
		$('*').contents().filter(function(this: cheerio.Element) {
			return this.type === 'text';
		}).each(function(this: cheerio.Element) {
			const trimmedText = trimText($(this).text(), maxTextLength);
			$(this).replaceWith(trimmedText);
		});
	}

	// Remove HTML comments
	trimHtmlComments($);

	// Remove meaningless attributes
	const omitAttrs = ['height', 'width', 'colspan', 'valign', 'align', 'style', 'cellspacing', 'color', 'bgcolor', 'border', 'cellpadding', 'bordercolor'];
	$('*').removeAttr(omitAttrs.join(' '));

	// Get the processed HTML
	let processedHtml = onlyBody ? $('body').html() || '' : $.html();

	// Trim output if maxOutputLength is set
	if (maxOutputLength > 0 && processedHtml.length > maxOutputLength) {
		processedHtml = processedHtml.substring(0, maxOutputLength) + '…';
	}

	// Calculate stats
	const stats = getStats(html, processedHtml);

	return {
		json: {
			html: processedHtml,
			stats: {
				inputLength: stats.inputLength,
				outputLength: stats.outputLength,
				compressionRatio: stats.compressionRatio,
				compressionRatioHuman: stats.compressionRatioHuman,
				htmlElements: stats.htmlElements,
				maxNestingLevel: stats.maxNestingLevel,
				nodesAtHalfDepth: stats.nodesAtHalfDepth,
			},
		},
	};
} 