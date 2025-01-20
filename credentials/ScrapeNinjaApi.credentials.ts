import {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ScrapeNinjaApi implements ICredentialType {
	name = 'scrapeNinjaApi';
	displayName = 'ScrapeNinja API';
	properties: INodeProperties[] = [
		{
			displayName: 'API Marketplace',
			name: 'marketplace',
			type: 'options',
			options: [
				{
					name: 'RapidAPI',
					value: 'rapidapi',
				},
				{
					name: 'APIRoad',
					value: 'apiroad',
				},
			],
			default: 'rapidapi',
			description: 'Choose your API marketplace',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'The API key (X-RapidAPI-Key for RapidAPI or X-Apiroad-Key for APIRoad)',
		},
	];
}
