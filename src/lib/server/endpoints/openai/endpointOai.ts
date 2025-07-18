import { z } from "zod";
import { openAICompletionToTextGenerationStream } from "./openAICompletionToTextGenerationStream";
import {
	openAIChatToTextGenerationSingle,
	openAIChatToTextGenerationStream,
} from "./openAIChatToTextGenerationStream";
import type { CompletionCreateParamsStreaming } from "openai/resources/completions";
import type {
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { FunctionDefinition, FunctionParameters } from "openai/resources/shared";
import { buildPrompt } from "$lib/buildPrompt";
import { config } from "$lib/server/config";
import type { Endpoint } from "../endpoints";
import type OpenAI from "openai";
import { createImageProcessorOptionsValidator, makeImageProcessor } from "../images";
import type { MessageFile } from "$lib/types/Message";
import { type Tool } from "$lib/types/Tool";
import type { EndpointMessage } from "../endpoints";
import { v4 as uuidv4 } from "uuid";
function createChatCompletionToolsArray(tools: Tool[] | undefined): ChatCompletionTool[] {
	const toolChoices = [] as ChatCompletionTool[];
	if (tools === undefined) {
		return toolChoices;
	}

	for (const t of tools) {
		const requiredProperties = [] as string[];

		const properties = {} as Record<string, unknown>;
		for (const idx in t.inputs) {
			const parameterDefinition = t.inputs[idx];

			const parameter = {} as Record<string, unknown>;
			switch (parameterDefinition.type) {
				case "str":
					parameter.type = "string";
					break;
				case "float":
				case "int":
					parameter.type = "number";
					break;
				case "bool":
					parameter.type = "boolean";
					break;
				case "file":
					throw new Error("File type's currently not supported");
				default:
					throw new Error(`Unknown tool IO type: ${t}`);
			}

			if ("description" in parameterDefinition) {
				parameter.description = parameterDefinition.description;
			}

			if (parameterDefinition.paramType == "required") {
				requiredProperties.push(t.inputs[idx].name);
			}

			properties[t.inputs[idx].name] = parameter;
		}

		const functionParameters: FunctionParameters = {
			type: "object",
			...(requiredProperties.length > 0 ? { required: requiredProperties } : {}),
			properties,
		};

		const functionDefinition: FunctionDefinition = {
			name: t.name,
			description: t.description,
			parameters: functionParameters,
		};

		const toolDefinition: ChatCompletionTool = {
			type: "function",
			function: functionDefinition,
		};

		toolChoices.push(toolDefinition);
	}

	return toolChoices;
}

export const endpointOAIParametersSchema = z.object({
	weight: z.number().int().positive().default(1),
	model: z.any(),
	type: z.literal("openai"),
	baseURL: z.string().url().default("https://api.openai.com/v1"),
	apiKey: z.string().default(config.OPENAI_API_KEY || config.HF_TOKEN || "sk-"),
	completion: z
		.union([z.literal("completions"), z.literal("chat_completions")])
		.default("chat_completions"),
	defaultHeaders: z.record(z.string()).optional(),
	defaultQuery: z.record(z.string()).optional(),
	extraBody: z.record(z.any()).optional(),
	multimodal: z
		.object({
			image: createImageProcessorOptionsValidator({
				supportedMimeTypes: [
					"image/png",
					"image/jpeg",
					"image/webp",
					"image/avif",
					"image/tiff",
					"image/gif",
				],
				preferredMimeType: "image/webp",
				maxSizeInMB: Infinity,
				maxWidth: 4096,
				maxHeight: 4096,
			}),
		})
		.default({}),
	/* enable use of max_completion_tokens in place of max_tokens */
	useCompletionTokens: z.boolean().default(false),
	streamingSupported: z.boolean().default(true),
});

export async function endpointOai(
	input: z.input<typeof endpointOAIParametersSchema>
): Promise<Endpoint> {
	const {
		baseURL,
		apiKey,
		completion,
		model,
		defaultHeaders,
		defaultQuery,
		multimodal,
		extraBody,
		useCompletionTokens,
		streamingSupported,
	} = endpointOAIParametersSchema.parse(input);

	let OpenAI;
	try {
		OpenAI = (await import("openai")).OpenAI;
	} catch (e) {
		throw new Error("Failed to import OpenAI", { cause: e });
	}

	const openai = new OpenAI({
		apiKey: apiKey || "sk-",
		baseURL,
		defaultHeaders,
		defaultQuery,
	});

	const imageProcessor = makeImageProcessor(multimodal.image);

	if (completion === "completions") {
		if (model.tools) {
			throw new Error(
				"Tools are not supported for 'completions' mode, switch to 'chat_completions' instead"
			);
		}
		return async ({
			messages,
			preprompt,
			continueMessage,
			generateSettings,
			conversationId,
			userId,
			userEmail,
		}) => {
			const prompt = await buildPrompt({
				messages,
				continueMessage,
				preprompt,
				model,
			});

			const parameters = { ...model.parameters, ...generateSettings };
			const body: CompletionCreateParamsStreaming = {
				model: model.id ?? model.name,
				prompt,
				stream: true,
				max_tokens: parameters?.max_new_tokens,
				stop: parameters?.stop,
				temperature: parameters?.temperature,
				top_p: parameters?.top_p,
				frequency_penalty: parameters?.repetition_penalty,
				presence_penalty: parameters?.presence_penalty,
			};

			const openAICompletion = await openai.completions.create(body, {
				body: { ...body, ...extraBody },
				headers: {
					"ChatUI-Conversation-ID": conversationId?.toString() ?? "",
					"ChatUI-User-Id": userId?.toString() ?? "",
					"ChatUI-User-Email": userEmail,
					"X-use-cache": "false",
				},
			});

			return openAICompletionToTextGenerationStream(openAICompletion);
		};
	} else if (completion === "chat_completions") {
		return async ({
			messages,
			preprompt,
			generateSettings,
			tools,
			toolResults,
			conversationId,
			userId,
			userEmail,
		}) => {
			// Format messages for the chat API, handling multimodal content if supported
			let messagesOpenAI: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
				await prepareMessages(messages, imageProcessor, !model.tools && model.multimodal);

			// Check if a system message already exists as the first message
			const hasSystemMessage = messagesOpenAI.length > 0 && messagesOpenAI[0]?.role === "system";

			if (hasSystemMessage) {
				// System message exists - preserve user configuration
				if (preprompt !== undefined) {
					// Prepend preprompt to existing system message if preprompt exists
					const userSystemPrompt = messagesOpenAI[0].content || "";
					messagesOpenAI[0].content =
						preprompt + (userSystemPrompt ? "\n\n" + userSystemPrompt : "");
				}
				// If no preprompt, user's system message remains unchanged
			} else {
				// No system message exists - create a new one with preprompt or empty string
				messagesOpenAI = [{ role: "system", content: preprompt ?? "" }, ...messagesOpenAI];
			}

			// Handle models that don't support system role by converting to user message
			// This maintains compatibility with older or non-standard models
			if (
				!model.systemRoleSupported &&
				messagesOpenAI.length > 0 &&
				messagesOpenAI[0]?.role === "system"
			) {
				messagesOpenAI[0] = {
					...messagesOpenAI[0],
					role: "user",
				};
			}

			// Format tool results for the API to provide context for follow-up tool calls
			// This creates the full conversation flow needed for multi-step tool interactions
			if (toolResults && toolResults.length > 0) {
				const toolCallRequests: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
					role: "assistant",
					content: null,
					tool_calls: [],
				};

				const responses: Array<OpenAI.Chat.Completions.ChatCompletionToolMessageParam> = [];

				for (const result of toolResults) {
					const id = result?.call?.toolId || uuidv4();

					const toolCallResult: OpenAI.Chat.Completions.ChatCompletionMessageToolCall = {
						type: "function",
						function: {
							name: result.call.name,
							arguments: JSON.stringify(result.call.parameters),
						},
						id,
					};

					toolCallRequests.tool_calls?.push(toolCallResult);
					const toolCallResponse: OpenAI.Chat.Completions.ChatCompletionToolMessageParam = {
						role: "tool",
						content: "",
						tool_call_id: id,
					};
					if ("outputs" in result) {
						toolCallResponse.content = JSON.stringify(result.outputs);
					}
					responses.push(toolCallResponse);
				}
				messagesOpenAI.push(toolCallRequests);
				messagesOpenAI.push(...responses);
			}

			// Combine model defaults with request-specific parameters
			const parameters = { ...model.parameters, ...generateSettings };
			const toolCallChoices = createChatCompletionToolsArray(tools);
			const body = {
				model: model.id ?? model.name,
				messages: messagesOpenAI,
				stream: streamingSupported,
				// Support two different ways of specifying token limits depending on the model
				...(useCompletionTokens
					? { max_completion_tokens: parameters?.max_new_tokens }
					: { max_tokens: parameters?.max_new_tokens }),
				stop: parameters?.stop,
				temperature: parameters?.temperature,
				top_p: parameters?.top_p,
				frequency_penalty: parameters?.repetition_penalty,
				presence_penalty: parameters?.presence_penalty,
				// Only include tool configuration if tools are provided
				...(toolCallChoices.length > 0 ? { tools: toolCallChoices, tool_choice: "auto" } : {}),
			};

			// Handle both streaming and non-streaming responses with appropriate processors
			if (streamingSupported) {
				const openChatAICompletion = await openai.chat.completions.create(
					body as ChatCompletionCreateParamsStreaming,
					{
						body: { ...body, ...extraBody },
						headers: {
							"ChatUI-Conversation-ID": conversationId?.toString() ?? "",
							"ChatUI-User-Id": userId?.toString() ?? "",
							"ChatUI-User-Email": userEmail,
							"X-use-cache": "false",
						},
					}
				);
				return openAIChatToTextGenerationStream(openChatAICompletion);
			} else {
				const openChatAICompletion = await openai.chat.completions.create(
					body as ChatCompletionCreateParamsNonStreaming,
					{
						body: { ...body, ...extraBody },
						headers: {
							"ChatUI-Conversation-ID": conversationId?.toString() ?? "",
							"ChatUI-User-Id": userId?.toString() ?? "",
							"ChatUI-User-Email": userEmail,
							"X-use-cache": "false",
						},
					}
				);
				return openAIChatToTextGenerationSingle(openChatAICompletion);
			}
		};
	} else {
		throw new Error("Invalid completion type");
	}
}

async function prepareMessages(
	messages: EndpointMessage[],
	imageProcessor: ReturnType<typeof makeImageProcessor>,
	isMultimodal: boolean
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
	return Promise.all(
		messages.map(async (message) => {
			if (message.from === "user" && isMultimodal) {
				return {
					role: message.from,
					content: [
						...(await prepareFiles(imageProcessor, message.files ?? [])),
						{ type: "text", text: message.content },
					],
				};
			}
			return {
				role: message.from,
				content: message.content,
			};
		})
	);
}

async function prepareFiles(
	imageProcessor: ReturnType<typeof makeImageProcessor>,
	files: MessageFile[]
): Promise<OpenAI.Chat.Completions.ChatCompletionContentPartImage[]> {
	const processedFiles = await Promise.all(
		files.filter((file) => file.mime.startsWith("image/")).map(imageProcessor)
	);
	return processedFiles.map((file) => ({
		type: "image_url" as const,
		image_url: {
			url: `data:${file.mime};base64,${file.image.toString("base64")}`,
		},
	}));
}
