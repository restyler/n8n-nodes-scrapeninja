import cheerio from 'cheerio';
import fs from 'fs/promises';
import { analyzeDOM } from './lib.js';

// Function to trim text and append ellipsis
function trimText(text) {
    const maxLength = 100;
    if (text.length > maxLength) {
        return text.substring(0, maxLength) + '… [' + (text.length - maxLength) + ' chars more]';
    }
    return text;
}

// Function to trim long attribute values, focusing on URLs
function trimAttrs($) {
    $('*').each(function() {
        const attrs = $(this).attr();
        for (const attr in attrs) {
            if (Object.prototype.hasOwnProperty.call(attrs, attr)) {
                const attrValue = attrs[attr];

                // Check if attribute value is a URL or potentially long link
                //if (isUrlOrLongLink(attrValue)) {
                if (isImportantAttr(attr)) {
                    //console.log('Trimming important attribute:', attr, 'with value:', attrValue);
                    $(this).attr(attr, trimUrl(attrValue, 70));
                } else {
                    //console.log('Trimming non-important attribute:', attr, 'with value:', attrValue);
                    $(this).attr(attr, trimUrl(attrValue, 30));
                }
                    
                //}
            }
        }
    });
}

function isImportantAttr(attrName) {
    return ['class', 'id'].includes(attrName);

}


// Helper function to determine if a string is a URL or a potentially long link
function isUrlOrLongLink(value) {
    const urlPattern = /^(http|https|\/)/; // Matches http, https, or starts with '/'
    return urlPattern.test(value) && value.length > 30;
}

// Helper function to trim a URL to a specified length
function trimUrl(url, maxLength) {
    if (url.length > maxLength) {
        return url.substring(0, maxLength) + '…';
        //return url.substring(0, maxLength) + '… [' + (url.length - maxLength) + ' chars more]';
    }
    return url;
}

// Function to remove inline JavaScript
function removeInlineJs($) {
    $('*[onclick], *[onmouseover], *[onchange], *[onload]').removeAttr('onclick onmouseover onchange onload');
}

// Function to trim embedded SVGs
function trimSvgs($) {
    $('svg').each(function() {
        const svgContent = $(this).html();
        $(this).html(trimText(svgContent));
    });
}

// Function to trim excessive whitespace
function trimWhitespace($) {
    $('*').contents().filter(function () {
        return this.type === 'text';
    }).each(function () {
        let text = $(this).text();
        text = text.replace(/\s{2,}/g, ' ');
        $(this).replaceWith(text);
    });
}

// Function to trim HTML comments to 30 characters with an ellipsis and count of additional characters
function trimHtmlComments($) {
    $('*').contents().filter(function() {
        return this.type === 'comment';
    }).each(function() {
        let commentText = this.data;
        if (commentText.length > 30) {
            //const trimmedComment = commentText.substring(0, 30) + '... [' + (commentText.length - 30) + ' chars more]';
            const trimmedComment = commentText.substring(0, 30) + '…';
            this.data = trimmedComment;
        }
    });
}


// Function to process HTML content
export async function processHtml(htmlContent, selector = '') {
    const $ = cheerio.load(htmlContent, { xmlMode: false });

    let stats = await analyzeDOM($);

    console.log('selector###', selector);
    // Reduce DOM tree to the specified selector
    if (selector) {
        const selectedElements = $(selector);
        if (selectedElements.length === 0) {
            throw new Error('Selector not found');
        }
        selectedElements.each(function () {
            console.log('siblings to remove:', $(this).siblings().length);
            $(this).siblings().remove();
            $('body').empty().append(this);
        });
    }

    // Remove <style> and <script> tags
    $('style, script').remove();

    // Remove inline JavaScript
    removeInlineJs($);

    // Trim SVG content
    trimSvgs($);

    // Trim whitespace
    trimWhitespace($);

    // trim hrefs to be max 30 chars
    $('a').each(function () {
        const href = $(this).attr('href');
        if (href && href.length > 30) {
            $(this).attr('href', href.substring(0, 30) + '…');
        }
    });

    // remove style attributes
    //$('*').removeAttr('style');

    // get rid of meaningless attrs: height, width, colspan, valign, align, style, cellspacing, color, etc
    let omitAttrs = ['height', 'width', 'colspan', 'valign', 'align', 'style', 'cellspacing', 'color', 'bgcolor', 'border', 'cellpadding', 'bordercolor', 'border', 'bordercolor'];
    $('*').removeAttr(omitAttrs.join(' '));

    // Remove HTML comments longer than 30 chars
    trimHtmlComments($);

    // trim every attr if value starts with "http" to be max 30 chars
    trimAttrs($);

    // Trim and replace text nodes
    $('*').contents().filter(function () {
        return this.type === 'text';
    }).each(function () {
        const trimmedText = trimText($(this).text());
        $(this).replaceWith(trimmedText);
    });

    // Call the functions in your main process
    const emmetCssRepresentation = generateEmmetCssRepresentation($);

    const emmetTopLevel = generateEmmetCssRepresentation($, 6, true);

    // Return both processed HTML and Emmet representation
    return {
        html: $.html(),
        emmet: emmetCssRepresentation,
        emmetTopLevel,
        stats
    };
}


function generateEmmetCssRepresentation($, maxDepth = 0, removeHeadAndHtml = false) {
    function cleanAttributeValue(value) {
        // Trims and replaces multiple spaces with a single space
        return value.replace(/\s+/g, ' ').trim();
    }

    function traverse(node, depth = 0) {
        const indent = ' '.repeat(depth);
        let emmetString = '';
        let childrenString = '';

        if (node.type === 'tag') {
            emmetString = node.name || '';

            // Process attributes to include in Emmet CSS
            const attrs = node.attribs;
            if (attrs) {
                const attrKeys = Object.keys(attrs);
                const prioritizedAttrs = ['class', 'src', 'data-'];
                attrKeys.sort((a, b) => prioritizedAttrs.indexOf(b) - prioritizedAttrs.indexOf(a));

                for (let i = 0; i < Math.min(attrKeys.length, 4); i++) {
                    const attr = attrKeys[i];
                    if (Object.prototype.hasOwnProperty.call(attrs, attr)) {
                        const cleanAttrValue = cleanAttributeValue(attrs[attr]);
                        emmetString += `[${attr}="${cleanAttrValue}"]`;
                    }
                }
            }

            // Process children if depth is within the limit
            if (maxDepth === 0 || depth < maxDepth) {
                node.children.forEach(child => {
                    const childString = traverse(child, depth + 1);
                    if (childString.trim()) {
                        // Avoiding new line for text representation
                        if (!childString.startsWith('{')) {
                            childrenString += `\n${indent}${childString}`;
                        } else {
                            childrenString += `${childString}`;
                        }
                    }
                });
            }

            return emmetString + childrenString;
        } else if (node.type === 'text') {
            // Process text nodes
            const textContent = node.data.trim();
            if (textContent) {
                return `{${textContent.substring(0, 30)}${textContent.length > 30 ? '…' : ''}${textContent.length > 120 ? '…' : ''}}`;
            }
        }

        return '';
    }

    // Start traversal from the root
    let rootNode = $('html')[0];
    if (removeHeadAndHtml) {
        rootNode = $('body')[0];
    }
    
    return traverse(rootNode);
}

/**
 * @param {import("./parser").ProcessFilesOptions} options - Description of the param.
 */
export async function processFiles(options) {
    try {
        const {
            inputHtmlFile,
            outputHtmlFile,
            outputEmmetFile,
            outputTopLevelEmmetFile,
            selector = null,
        } = options;

        // Read the input HTML file
        const inputHtml = await fs.readFile(inputHtmlFile, 'utf8');
        console.log('Input file has', inputHtml.length, 'chars');

        // Process HTML and generate Emmet CSS representation
        const { html, emmet, emmetTopLevel } = await processHtml(inputHtml, selector);

        // Write the processed HTML to the output file
        await fs.writeFile(outputHtmlFile, html, 'utf8');
        console.log('Output file has', html.length, 'chars');

        // Write the Emmet CSS representation to the output file
        await fs.writeFile(outputEmmetFile, emmet, 'utf8');
        console.log('Emmet representation saved as:', outputEmmetFile, 'chars size', emmet.length);

        // Write the Emmet CSS top level representation to the output file
        await fs.writeFile(outputTopLevelEmmetFile, emmetTopLevel, 'utf8');
        console.log('Emmet top-level representation saved as:', outputTopLevelEmmetFile, 'chars size', emmetTopLevel.length);

        // Calculate percent reduction
        const percentReduction = (1 - html.length / inputHtml.length) * 100;
        console.log('Percent reduction:', percentReduction.toFixed(2), '%');

        console.log('emmet top level percent reduction:', (1 - emmetTopLevel.length / inputHtml.length) * 100, '%');
    } catch (err) {
        console.error('Error processing the files:', err);
    }
}