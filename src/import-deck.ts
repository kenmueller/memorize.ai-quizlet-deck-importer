import axios from 'axios'
import * as _ from 'lodash'
import * as mime from 'mime'
import { v4 as uuid } from 'uuid'
import { nanoid } from 'nanoid'
import Batch from 'firestore-batch'
import { AllHtmlEntities as Entities } from 'html-entities'

import { ACCOUNT_ID, MAX_NUMBER_OF_CARDS_IN_SECTION, ASSET_CHUNK_SIZE } from './constants'
import { errorWithCode, storageUrl, slugify } from './helpers'
import admin, { firestore, storage } from './firebase-admin'

interface PageDataTerm {
	id: number
	word: string
	definition: string
	_imageUrl: string | null
	_wordAudioUrl: string | null
	_definitionAudioUrl: string | null
}

interface PageData {
	set: {
		title: string
		_thumbnailUrl: string | null
	}
	originalOrder: number[]
	termIdToTermsMap: Record<string, PageDataTerm>
}

interface Asset {
	destination: string
	url: string
	contentType: string
	token: string
}

const PAGE_DATA_REGEX = /\(function\(\)\{window\.Quizlet\["setPageData"\] = (.+?); QLoad\("Quizlet\.setPageData"\);\}\)\.call\(this\);\(function\(\)\{var script = document\.querySelector\("#.+?"\);script\.parentNode\.removeChild\(script\);\}\)\(\);<\/script>/

const entities = new Entities

let assets: Asset[] = []

export default async (deckId: string, extension: string, topics: string[]) => {
	assets = []
	
	process.stdout.write('Retrieving page data...')
	const { name, imageUrl, terms } = await getPageData(deckId, extension)
	console.log(' DONE')
	
	process.stdout.write('Importing deck...')
	try {
		await importDeck(deckId, topics, name, imageUrl)
	} catch (error) {
		console.error(error)
		
		throw error.code === 6
			? errorWithCode(
				`The deck with ID ${deckId} already exists`,
				'deck-already-exists'
			)
			: error
	}
	console.log(' DONE')
	
	await importCards(deckId, terms)
	
	await uploadAssets()
	
	return deckId
}

const importDeck = (deckId: string, topics: string[], name: string, imageUrl: string | null) => {
	const createDeck = firestore.doc(`decks/${deckId}`).create({
		slugId: nanoid(10),
		slug: slugify(name),
		topics,
		hasImage: Boolean(imageUrl),
		name,
		subtitle: '',
		description: '',
		viewCount: 0,
		uniqueViewCount: 0,
		ratingCount: 0,
		'1StarRatingCount': 0,
		'2StarRatingCount': 0,
		'3StarRatingCount': 0,
		'4StarRatingCount': 0,
		'5StarRatingCount': 0,
		averageRating: 0,
		downloadCount: 0,
		cardCount: 0,
		unsectionedCardCount: 0,
		currentUserCount: 0,
		allTimeUserCount: 0,
		favoriteCount: 0,
		creator: ACCOUNT_ID,
		created: admin.firestore.FieldValue.serverTimestamp(),
		updated: admin.firestore.FieldValue.serverTimestamp(),
		source: 'quizlet',
		originalId: deckId
	})
	
	return imageUrl
		? Promise.all([
			createDeck,
			getAssetUrl(imageUrl, `decks/${deckId}`)
		])
		: createDeck
}

const importCards = async (deckId: string, terms: PageDataTerm[]) => {
	const cardBatch = new Batch(firestore)
	
	let section: string | undefined
	let nextSectionIndex = 0
	let sectionSize = 0
	
	for (const term of terms) {
		if (!(sectionSize % MAX_NUMBER_OF_CARDS_IN_SECTION)) {
			process.stdout.write(`Creating section #${nextSectionIndex + 1}...`)
			
			section = await createSection(deckId, nextSectionIndex++)
			sectionSize = 0
			
			console.log(' DONE')
		}
		
		cardBatch.set(firestore.collection(`decks/${deckId}/cards`).doc(), {
			section,
			...getCardSides({
				front: term.word,
				back: term.definition,
				imageUrl: term._imageUrl && getAssetUrl(
					term._imageUrl,
					id => `deck-assets/${deckId}/${id}`
				),
				frontAudioUrl: term._wordAudioUrl && getAssetUrl(
					term._wordAudioUrl,
					id => `deck-assets/${deckId}/${id}`
				),
				backAudioUrl: term._definitionAudioUrl && getAssetUrl(
					term._definitionAudioUrl,
					id => `deck-assets/${deckId}/${id}`
				)
			}),
			viewCount: 0,
			reviewCount: 0,
			skipCount: 0
		})
		
		sectionSize++
	}
	
	process.stdout.write(`Importing ${terms.length} cards...`)
	await cardBatch.commit()
	console.log(' DONE')
}

const uploadAssets = async () => {
	const chunked = _.chunk(assets, ASSET_CHUNK_SIZE)
	let i = 0
	
	for (const chunk of chunked) {
		const message = `Uploading asset chunk ${++i}/${chunked.length}... `
		
		process.stdout.write(`${message}0/${chunk.length}\r`)
		
		let j = 0
		
		await Promise.all(chunk.map(async ({ destination, url, contentType, token }) => {
			try {
				const { data } = await axios.get(url, { responseType: 'arraybuffer' })
				
				await storage.file(destination).save(data, {
					public: true,
					metadata: {
						contentType,
						owner: ACCOUNT_ID,
						metadata: {
							firebaseStorageDownloadTokens: token
						}
					}
				})
				
				process.stdout.write(`${message}${++j}/${chunk.length}\r`)
			} catch (error) {
				console.error(`Error uploading asset ${++j}/${chunk.length}: ${error}`)
			}
		}))
		
		console.log()
	}
}

const getCardSides = (
	{
		front,
		back,
		imageUrl,
		frontAudioUrl,
		backAudioUrl
	}: {
		front: string,
		back: string,
		imageUrl: string | null,
		frontAudioUrl: string | null,
		backAudioUrl: string | null
	}
) => {
	front = `<h3 style="text-align:center;">${richTextToHtml(front)}</h3>`
	back = `<h3 style="text-align:center;">${richTextToHtml(back)}</h3>`
	
	imageUrl = imageUrl ? `<figure class="image"><img src="${imageUrl}"></figure>` : ''
	frontAudioUrl = frontAudioUrl ? `<audio src="${frontAudioUrl}"></audio>` : ''
	backAudioUrl = backAudioUrl ? `<audio src="${backAudioUrl}"></audio>` : ''
	
	return {
		front: `${frontAudioUrl}${front}`,
		back: `${backAudioUrl}${imageUrl}${back}`
	}
}

const richTextToHtml = (text: string) =>
	entities.encode(text)
		.replace(/\\n/g, '<br>')
		.replace(/\*(.+?)\*/g, '<strong>$1</strong>')

const getAssetUrl = (url: string, destination: string | ((id: string) => string)) => {
	if (url.startsWith('/tts/'))
		return null
	
	console.log(`Getting asset url for ${url = normalizeUrl(url)}`)
	
	const contentType = getContentType(url)
	
	if (!contentType)
		throw errorWithCode(
			'Unknown content type',
			'unknown-content-type'
		)
	
	console.log(`Found content type: ${contentType}`)
	
	const token = uuid()
	const rawDestination = typeof destination === 'string'
		? destination
		: destination(firestore.collection('quizlet-assets').doc().id)
	
	assets.push({
		destination: rawDestination,
		url,
		contentType,
		token
	})
	
	const newUrl = storageUrl(rawDestination.split('/'), token)
	console.log(`Found storage url: ${newUrl}`)
	
	return newUrl
}

const normalizeUrl = (url: string) =>
	url.startsWith('/')
		? `https://quizlet.com${url}`
		: url

const getContentType = (url: string) =>
	mime.getType(url.split('?')[0])

const getPageData = async (deckId: string, extension: string) => {
	try {
		const rawPageData: string | undefined = (
			(await axios.get(`https://quizlet.com/${deckId}/${extension}/`)).data.match(PAGE_DATA_REGEX) ?? []
		)[1]
		
		if (!rawPageData)
			throw errorWithCode(
				`Unable to get the page data for the deck with ID ${deckId}`,
				'page-data-unavailable'
			)
		
		const {
			set: { title, _thumbnailUrl },
			originalOrder: order,
			termIdToTermsMap: termsMap
		}: PageData = JSON.parse(rawPageData)
		
		return {
			name: title,
			imageUrl: _thumbnailUrl,
			terms: order.map(id => termsMap[id])
		}
	} catch (error) {
		if (error.code === 'page-data-unavailable')
			throw error
		
		console.error(error)
		throw errorWithCode(
			`Bad request to retrieve the page data for the deck with ID ${deckId}`,
			'page-data-bad-request'
		)
	}
}

const createSection = async (deckId: string, index: number) => {
	const ref = firestore.collection(`decks/${deckId}/sections`).doc()
	
	await ref.create({
		name: `Section ${index + 1}`,
		index,
		cardCount: 0
	})
	
	return ref.id
}
