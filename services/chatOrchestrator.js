const dbTools = require("./dbTools");
const retrievalService = require("./retrievalService");
const Chat = require("../models/chat.model");
const ChatMessage = require("../models/chatMessage.model");

class ChatOrchestrator {
  constructor() {
    // Register failover providers with Mistral as default primary (Fix 3)
    this.providers = [
      {
        name: "Mistral",
        url: "https://api.mistral.ai/v1/chat/completions",
        model: "mistral-small-latest",
        apiKey: process.env.MISTRAL_API_KEY,
      },
      {
        name: "Groq",
        url: "https://api.groq.com/openai/v1/chat/completions",
        model: "llama-3.1-70b-versatile",
        apiKey: process.env.GROQ_API_KEY,
      },
      {
        name: "OpenRouter",
        url: "https://openrouter.ai/api/v1/chat/completions",
        model: "meta-llama/llama-3.1-8b-instruct",
        apiKey: process.env.OPENROUTER_API_KEY,
      },
    ].filter((p) => p.apiKey);

    // Read-only lookups only (Fix 3 from CHAT-FIXES-6)
    this.tools = [
      {
        type: "function",
        function: {
          name: "searchProducts",
          description: "Search active product catalog by name, sku, category, or description keywords.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query or keywords" },
              categoryName: { type: "string", description: "Filter by category name (e.g., chairs, tables)" },
              limit: { type: "number", description: "Limit search results. Default is 5." },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getProductDetails",
          description: "Retrieve specifications, inventory, description, dimensions, and price for a specific product using its SKU or productId.",
          parameters: {
            type: "object",
            properties: {
              sku: { type: "string", description: "Stock Keeping Unit (SKU) of the product" },
              productId: { type: "string", description: "The product's MongoDB ID" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getOrderStatus",
          description: "Retrieve tracking status, items, billing info, and shipping address for a user order.",
          parameters: {
            type: "object",
            properties: {
              orderId: { type: "string", description: "The unique order ID string" },
              email: { type: "string", description: "Customer's email address associated with the order (for guest lookup)" },
            },
            required: ["orderId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getOrderHistory",
          description: "Retrieve the order history for the logged-in customer.",
          parameters: {
            type: "object",
            properties: {
              userId: { type: "string", description: "The customer's MongoDB ID" },
            },
            required: ["userId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getDefaultAddress",
          description: "Get the customer's saved default shipping address if they are logged in.",
          parameters: {
            type: "object",
            properties: {
              userId: { type: "string", description: "The customer's MongoDB ID" },
            },
            required: ["userId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getSavedAddresses",
          description: "Get all saved addresses for the logged-in customer.",
          parameters: {
            type: "object",
            properties: {
              userId: { type: "string", description: "The customer's MongoDB ID" },
            },
            required: ["userId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getProfileInfo",
          description: "Get the logged-in customer's profile info (name, email, phone, etc.).",
          parameters: {
            type: "object",
            properties: {
              userId: { type: "string", description: "The customer's MongoDB ID" },
            },
            required: ["userId"],
          },
        },
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Emit a Socket.IO event to a specific chat room */
  _emitToRoom(chatRoomId, event, data) {
    if (global.notificationGateway) {
      global.notificationGateway.io.to(`chat:${chatRoomId}`).emit(event, data);
    }
  }

  /**
   * FIX 3 — Defensive output sanitizer (Fix 3 from CHAT-FIXES-6 & Fix 1 from CHAT-FIXES-7).
   * Strips leaked tool-call syntax, JSON snippets, or natural language references to internal tools.
   */
  sanitizeResponse(text) {
    if (!text) return text;

    let clean = text;

    // Strip unexecuted function tags and JSON parameters
    clean = clean.replace(/(?:<)?function=\w+>.*?(?:<\/function>|>)/gs, "").trim();
    clean = clean.replace(/<\/function>/gi, "").trim();
    clean = clean.replace(/(?:<)?function=\w+>\{[^}]*\}/g, "").trim();
    clean = clean.replace(/\{"name":\s*"\w+",\s*"parameters":\s*\{[^}]*\}\}/g, "").trim();

    // Strip internal narration about calling tools/functions
    clean = clean.replace(/I(?:'ll| will| need to| am going to)(?: use| call| invoke| execute)[\w\s]*(?:function|tool|API)[^.]*\./gi, "").trim();
    clean = clean.replace(/(?:Let me|I'll|I will) (?:search|look up|check|query|call)[^.]*\./gi, "").trim();
    clean = clean.replace(/(?:Since the previous attempt failed|let me try again)[^.]*\./gi, "").trim();

    // Strip internal mechanics mentions (Fix 1 from CHAT-FIXES-7)
    clean = clean.replace(/\b(?:using|calling|invoking)\s+the\s+(?:tool|function|api|database tool|lookup tool)\b[^.]*\./gi, "").trim();
    clean = clean.replace(/\b(?:system|backend|orchestrator)\s+(?:provided|requires|executes)\b[^.]*\./gi, "").trim();

    // Strip pseudo-tool-call syntax patterns
    clean = clean.replace(/CALL:\s*\w+\([^)]*\)/g, "").trim();

    // Strip naked JSON fragments
    clean = clean.replace(/\{"(?:query|orderId|sku|productId|categoryName|limit|userId)":[^}]+\}/g, "").trim();

    // Normalise multiple blank lines
    clean = clean.replace(/\n{3,}/g, "\n\n").trim();

    return clean;
  }

  async streamTokens(chatRoomId, text) {
    if (!global.notificationGateway || !text) return;

    const chunks = text.match(/.{1,4}/g) || [];
    for (const chunk of chunks) {
      this._emitToRoom(chatRoomId, "ai:token", { chatId: chatRoomId, token: chunk });
    }

    this._emitToRoom(chatRoomId, "ai:complete", { chatId: chatRoomId });
  }

  /**
   * Helper to resolve ordinal references (e.g. "option 10")
   */
  resolveOrdinalReference(messageText, lastOptions) {
    if (!lastOptions || lastOptions.length === 0) return null;

    const clean = messageText.toLowerCase().trim();

    const matchNum = clean.match(/(?:option|number|no\.?|opt|choice|item)\s*(?:number\s*)?(\d+)/i);
    if (matchNum) {
      const idx = parseInt(matchNum[1], 10) - 1;
      if (idx >= 0 && idx < lastOptions.length) {
        return lastOptions[idx];
      }
    }

    const wordsMap = {
      first: 0, second: 1, third: 2, fourth: 3, fifth: 4,
      sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9
    };
    const wordMatch = clean.match(/(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*(?:one|option|choice|item|product)?/i);
    if (wordMatch) {
      const idx = wordsMap[wordMatch[1]];
      if (idx >= 0 && idx < lastOptions.length) {
        return lastOptions[idx];
      }
    }

    if (clean.includes("last one") || clean.includes("last option") || clean.includes("last product") || clean.includes("last item")) {
      return lastOptions[lastOptions.length - 1];
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  async handleUserMessage(chatId, userMessageContent, customerEmail, customerId = null) {
    const startTime = Date.now();
    const chatRoomId = chatId.toString();

    // FIX 2 (Fast-Path Layer): Intercept greetings, name, capabilities, & identity questions instantly (sub-50ms)
    const cleanMessage = userMessageContent.trim().toLowerCase().replace(/[!?.,]/g, "");

    // 1. Fast Path - Greetings
    if (/^\s*(hi|hello|hey|howdy|greetings|good\s+(?:morning|afternoon|evening|day)|welcome)\s*$/i.test(cleanMessage)) {
      this._emitToRoom(chatRoomId, "ai:thinking_start", { chatId: chatRoomId });
      const reply = "Hello! Welcome to Aura Interiors. I'm Aura Assistant, your home design and support assistant. How can I help you find the perfect piece or assist you with your orders today?";
      this._emitToRoom(chatRoomId, "ai:thinking_stop", { chatId: chatRoomId });
      console.log(`[ORCHESTRATOR] Fast-path Greeting matched. Completed in ${Date.now() - startTime}ms.`);
      return reply;
    }

    // 2. Fast Path - Name
    if (/who\s+are\s+you|what\s+is\s+your\s+name|whats\s+your\s+name|your\s+name/i.test(cleanMessage)) {
      this._emitToRoom(chatRoomId, "ai:thinking_start", { chatId: chatRoomId });
      const reply = "I'm Aura Assistant, your dedicated home-interiors and support assistant at Aura Interiors. I'm here to help you browse our catalog, check orders, and manage your account details. What can I do for you today?";
      this._emitToRoom(chatRoomId, "ai:thinking_stop", { chatId: chatRoomId });
      console.log(`[ORCHESTRATOR] Fast-path Name matched. Completed in ${Date.now() - startTime}ms.`);
      return reply;
    }

    // 3. Fast Path - Capabilities
    if (/what\s+can\s+you\s+do|what\s+can\s+you\s+help|how\s+can\s+you\s+help|capabilities/i.test(cleanMessage)) {
      this._emitToRoom(chatRoomId, "ai:thinking_start", { chatId: chatRoomId });
      const reply = "I can help you browse our product catalog, get detailed specifications and stock levels, look up your order history and tracking status, check your default or saved addresses, or view your profile information. If you ever need complex assistance, you can click the 'Talk to a human' button above the chat input field to connect with a representative.";
      this._emitToRoom(chatRoomId, "ai:thinking_stop", { chatId: chatRoomId });
      console.log(`[ORCHESTRATOR] Fast-path Capabilities matched. Completed in ${Date.now() - startTime}ms.`);
      return reply;
    }

    // 4. Fast Path - Bot / Identity
    if (/are\s+you\s+a\s+bot|are\s+you\s+ai|are\s+you\s+a\s+robot|are\s+you\s+human|real\s+person/i.test(cleanMessage)) {
      this._emitToRoom(chatRoomId, "ai:thinking_start", { chatId: chatRoomId });
      const reply = "I am Aura Assistant, the AI support chatbot for Aura Interiors. I can instantly look up products, orders, and addresses. If you'd prefer to speak with a human support agent, you can click the 'Talk to a human' button above the chat input field at any time!";
      this._emitToRoom(chatRoomId, "ai:thinking_stop", { chatId: chatRoomId });
      console.log(`[ORCHESTRATOR] Fast-path Bot Identity matched. Completed in ${Date.now() - startTime}ms.`);
      return reply;
    }

    this._emitToRoom(chatRoomId, "ai:thinking_start", { chatId: chatRoomId });

    try {
      const chat = await Chat.findById(chatId);
      if (!chat) throw new Error("Chat session not found");

      // Redirect human requests
      const humanKeywords = ["talk to a human", "speak to a human", "talk to an agent", "speak to an agent", "agent", "human", "representative", "support agent", "live agent", "escalate"];
      const seeksHuman = humanKeywords.some(kw => new RegExp(`\\b${kw}\\b`, "i").test(cleanMessage));

      if (seeksHuman) {
        this._emitToRoom(chatRoomId, "ai:thinking_stop", { chatId: chatRoomId });
        return "You can reach a live support agent anytime by clicking the 'Talk to a human' button above the chat input field.";
      }

      console.log(`[ORCHESTRATOR] Starting parallel RAG + history fetch`);
      const [recentMessages, ragChunks] = await Promise.all([
        ChatMessage.find({ chat: chatId }).sort({ createdAt: -1 }).limit(6).lean(), // trimmed history context size (Fix 2)
        retrievalService.search(userMessageContent, 3, 0.45).catch(() => []),
      ]);

      const parallelTime = Date.now() - startTime;
      console.log(`[ORCHESTRATOR] Parallel fetch done in ${parallelTime}ms`);

      // Build chronological message history
      recentMessages.reverse();
      const messages = recentMessages.map((msg) => ({
        role: msg.senderRole === "customer" ? "user" : "assistant",
        content: msg.content,
      }));

      // FIX 2b: Resolve ordinal references
      if (chat.metadata && Array.isArray(chat.metadata.lastProductOptions)) {
        const resolvedProductRef = this.resolveOrdinalReference(userMessageContent, chat.metadata.lastProductOptions);
        if (resolvedProductRef) {
          console.log(`[ORCHESTRATOR] Resolved ordinal reference to product: ${resolvedProductRef.name}`);
          messages.push({
            role: "system",
            content: `Context: The user's query references product option "${resolvedProductRef.name}" (SKU: ${resolvedProductRef.sku}, ID: ${resolvedProductRef.id}). Call getProductDetails with this product info if they are asking about it.`
          });
        }
      }

      if (messages.length === 0 || messages[messages.length - 1].content !== userMessageContent) {
        messages.push({ role: "user", content: userMessageContent });
      }

      // Build RAG context string
      let contextText = "No relevant knowledge documents found.";
      if (ragChunks.length > 0) {
        contextText = ragChunks
          .map((chunk, i) => `[Doc ${i + 1} - Source: ${chunk.fileName}]:\n${chunk.text}`)
          .join("\n\n");
      }

      const customerContext = customerId
        ? `The customer is logged in. Their userId is: ${customerId}. Email on file: ${customerEmail || "available"}.`
        : `The customer is a guest (not logged in). Email: ${customerEmail || "not provided"}.`;

      // FIX 1 & 4 (Tone & Professionalism Instructions)
      const systemPrompt = `You are Aura Assistant, the AI Support Chatbot for Aura Interiors.
Your name is Aura Assistant. If asked your name or who you are, always respond with exactly "Aura Assistant" — never use any other name.

TONE & STYLE RULES:
- You are warm, professional, friendly, and conversational.
- NEVER respond in short curt fragments (e.g., if asked your name, do NOT just say "Aura Assistant."). Always respond in complete, friendly sentences.
- NEVER mention internal mechanics, tools, APIs, function names, backend code, or system architecture. Speak to the customer in clear, non-technical language.
- Examples:
  * Bad: "I will use the getOrderStatus tool."
  * Good: "I can look up your order status for you."
  * Bad: "Aura Assistant."
  * Good: "I'm Aura Assistant — happy to help! How can I assist you with your home interior needs today?"

Knowledge Context (FAQs, policies, and shipping/refund details):
---
${contextText}
---

Customer Context:
${customerContext}

TOOL AVAILABILITY BY AUTH STATUS:
- GUEST USERS (not logged in):
  * ✓ Can use: searchProducts, getProductDetails, getOrderStatus (via orderId + email)
  * ✗ Cannot use: getOrderHistory, getDefaultAddress, getSavedAddresses, getProfileInfo
  * When guest tries to use auth-required tools: Respond warmly with graceful decline. NO tool names. Explain they need to create an account or sign in, then offer them the option to do so. Example: "I'd love to help with that, but I need you to be logged into your account to access your saved addresses. Would you like to create a free account or sign in now?"

- LOGGED-IN USERS:
  * ✓ Can use: All tools (searchProducts, getProductDetails, getOrderStatus, getOrderHistory, getDefaultAddress, getSavedAddresses, getProfileInfo)

Rules:
1. Try to answer user questions using the Knowledge Context above.
2. If the user asks about product prices, details, inventory, category listings, order history, addresses, or profile info, ALWAYS call the corresponding database tools instead of guessing.
3. Grounding: Never make up policies, prices, stock levels, or order details. Keep responses factual.
4. Links: When mentioning products or providing links, always format them as markdown links: [Product Name](url). Only use URLs you received from tool results — never construct or guess a URL yourself.
5. Catalog Validation: Before recommending any product mentioned in the RAG context, you MUST verify that the product exists and is active in the live store by calling 'searchProducts' or 'getProductDetails'. If the search fails or the product is out of stock, DO NOT recommend it.
6. NO ORDER PLACEMENT: You cannot place orders, edit addresses, or process payments directly. If the customer wants to make a purchase, guide them to complete it themselves by providing the direct product page link.
7. NO MANUAL ESCALATION: You cannot transfer users to human agents. If they request an agent or you cannot answer, direct them to use the 'Talk to a human' button above the chat input area.
8. GRACEFUL DEGRADATION: If a guest asks for a feature that requires authentication, respond warmly in natural language (no tool mentions) and offer a sign-in suggestion. Continue the conversation normally.`;

      const apiMessages = [{ role: "system", content: systemPrompt }, ...messages];

      const llmStart = Date.now();
      const rawResponse = await this.runLLMLoop(chat, apiMessages, 0, customerId);
      const llmTime = Date.now() - llmStart;
      console.log(`[ORCHESTRATOR] LLM loop completed in ${llmTime}ms`);

      const cleanResponse = this.sanitizeResponse(rawResponse);

      const totalTime = Date.now() - startTime;
      console.log(`[ORCHESTRATOR] ✓ Total: ${totalTime}ms | RAG+history: ${parallelTime}ms | LLM: ${llmTime}ms`);

      this._emitToRoom(chatRoomId, "ai:thinking_stop", { chatId: chatRoomId });
      return cleanResponse;
    } catch (error) {
      console.error("[ORCHESTRATOR] Error in handleUserMessage:", error.message);
      this._emitToRoom(chatRoomId, "ai:error", { chatId: chatRoomId, error: "Processing failed" });
      return "I encountered an error. If you need help, please click the 'Talk to a human' button above to reach a representative.";
    }
  }

  // ---------------------------------------------------------------------------
  // LLM Tool-Calling Loop with Silent Multi-Provider Failover (Fix 3)
  // ---------------------------------------------------------------------------

  async callLLMWithFailover(apiMessages, depth) {
    let lastError = null;

    for (const provider of this.providers) {
      try {
        console.log(`[ORCHESTRATOR] Querying LLM via ${provider.name} (${provider.model})...`);
        
        // Timeout protection to ensure sub-2-second target (6s fallback safety)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        // Clean messages to remove any extra custom fields (like refusal, reasoning) that cause validation errors (e.g. on Mistral)
        const cleanedMessages = apiMessages.map((msg) => {
          const cleanMsg = {
            role: msg.role,
            content: msg.content === undefined ? null : msg.content,
          };
          if (msg.tool_calls) cleanMsg.tool_calls = msg.tool_calls;
          if (msg.name) cleanMsg.name = msg.name;
          if (msg.tool_call_id) cleanMsg.tool_call_id = msg.tool_call_id;
          return cleanMsg;
        });

        const response = await fetch(provider.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify({
            model: provider.model,
            messages: cleanedMessages,
            tools: this.tools.length > 0 ? this.tools : undefined,
            tool_choice: this.tools.length > 0 ? "auto" : undefined,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Status ${response.status}: ${errText}`);
        }

        const result = await response.json();
        console.log(`[ORCHESTRATOR] Success response from ${provider.name}`);
        return { result, providerName: provider.name };
      } catch (err) {
        lastError = err;
        console.warn(`[ORCHESTRATOR] Provider ${provider.name} failed: ${err.message}. Retrying fallback...`);
      }
    }

    throw new Error(`All LLM providers failed. Last error: ${lastError?.message}`);
  }

  async runLLMLoop(chat, apiMessages, depth = 0, customerId = null) {
    if (depth >= 5) {
      console.warn("[ORCHESTRATOR] Maximum tool loop depth reached");
      return "I'm having trouble completing this request. Please click the 'Talk to a human' button above to speak with a representative.";
    }

    try {
      const { result } = await this.callLLMWithFailover(apiMessages, depth);
      
      const choice = result.choices[0];
      const message = choice.message;

      // Ensure we check for native tool calls first
      let toolCalls = message.tool_calls || [];

      // Support text-based function fallback parsing only if no native tool calls are present
      if (toolCalls.length === 0 && message.content && typeof message.content === "string") {
        const textToolRegex = /(?:<)?function=(\w+)>(.*?)(?:<\/function>|>)/gs;
        let match;
        textToolRegex.lastIndex = 0;

        while ((match = textToolRegex.exec(message.content)) !== null) {
          const fnName = match[1];
          const argsStr = match[2].trim();
          const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

          toolCalls.push({
            id: toolCallId,
            type: "function",
            function: {
              name: fnName,
              arguments: argsStr,
              isTextFallback: true,
              rawMatch: match[0],
            },
          });
        }
      }

      // Append LLM response to history context
      apiMessages.push(message);

      if (toolCalls.length > 0) {
        console.log(`[ORCHESTRATOR] Executing ${toolCalls.length} tool call(s)`);

        for (const toolCall of toolCalls) {
          const { name, arguments: argsString } = toolCall.function;
          let args = {};
          try {
            args = JSON.parse(argsString);
          } catch (e) {
            console.error("Failed to parse tool arguments:", argsString);
          }

          console.log(`[ORCHESTRATOR] → tool: ${name}`, args);

          let toolOutput = "";

          // ===== GUEST DEGRADATION LOGIC =====
          // Auth-required tools: return graceful degradation message when guest (no customerId)
          const authRequiredTools = ["getOrderHistory", "getDefaultAddress", "getSavedAddresses", "getProfileInfo"];
          if (authRequiredTools.includes(name) && !customerId) {
            console.log(`[ORCHESTRATOR] Guest user attempted auth-required tool: ${name}. Returning degradation message.`);
            const degradationMessage = `I'd love to help with that, but I need you to be logged into your account to access your saved information. Once you create a free account or sign in, I'll be able to help you manage your profile, addresses, and view your complete order history. Would you like to create an account or sign in now?`;
            toolOutput = JSON.stringify({
              error: "requires_account",
              message: degradationMessage,
              userFacing: true,
              suggestion: "Please sign in or create an account to access this feature."
            });
          }
          // ===== END GUEST DEGRADATION LOGIC =====
          else if (name === "searchProducts") {
            const products = await dbTools.searchProducts(args);
            toolOutput = JSON.stringify(products);

            // Store search results in session metadata for positional reference resolution
            if (Array.isArray(products) && products.length > 0) {
              chat.metadata = chat.metadata || {};
              chat.metadata.lastProductOptions = products.map(p => ({
                id: p.id,
                name: p.name,
                sku: p.sku,
                url: p.url
              }));
              chat.markModified("metadata");
              await chat.save().catch(err => console.error("Failed to save chat metadata:", err.message));
            }
          } else if (name === "getProductDetails") {
            const details = await dbTools.getProductDetails(args);
            toolOutput = JSON.stringify(details);
          } else if (name === "getOrderStatus") {
            if (customerId && !args.userId) {
              args.userId = customerId;
            }
            const status = await dbTools.getOrderStatus(args);
            toolOutput = JSON.stringify(status);
          } else {
            toolOutput = JSON.stringify({ error: `Tool ${name} not found or descoped.` });
          }

          // Strip text-fallback tag from message content if used
          if (toolCall.function.isTextFallback && toolCall.function.rawMatch) {
            message.content = message.content.replace(toolCall.function.rawMatch, "").trim();
          }

          apiMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: name,
            content: toolOutput,
          });
        }

        return this.runLLMLoop(chat, apiMessages, depth + 1, customerId);
      }

      return message.content || "I am connecting you to an admin who can assist you.";
    } catch (err) {
      console.error("[ORCHESTRATOR] LLM API Call failed:", err.message);
      return "I'm having trouble retrieving details right now. Please click the 'Talk to a human' button above to reach a representative.";
    }
  }

  // ---------------------------------------------------------------------------
  // Escalation
  // ---------------------------------------------------------------------------

  async triggerEscalation(chat, reason) {
    try {
      console.log(`[ORCHESTRATOR] Escalating chat ${chat._id} — reason: ${reason}`);

      let aiSummary = "";
      if (this.apiKey) {
        try {
          const recentMsgs = await ChatMessage.find({ chat: chat._id })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();
          recentMsgs.reverse();

          const transcriptText = recentMsgs
            .map((m) => `${m.senderRole === "customer" ? "Customer" : "AI/Admin"}: ${m.content}`)
            .join("\n");

          const response = await fetch(this.apiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              messages: [
                {
                  role: "system",
                  content:
                    "You are an assistant. Summarize the following customer support conversation context in exactly 1 or 2 sentences for the human agent. Focus on what the user wants and what remains unresolved.",
                },
                {
                  role: "user",
                  content:
                    transcriptText ||
                    `Customer started a conversation. Reason for escalation: ${reason}`,
                },
              ],
              model: this.modelName,
            }),
          });

          if (response.ok) {
            const summaryRes = await response.json();
            aiSummary = summaryRes.choices?.[0]?.message?.content || "";
          }
        } catch (sumErr) {
          console.warn("Failed to generate AI summary on escalation:", sumErr.message);
        }
      }

      chat.status = "escalated";
      chat.metadata = {
        ...(chat.metadata || {}),
        botActive: false,
        escalationReason: reason,
        escalatedAt: new Date(),
        aiSummary: aiSummary || "No summary available.",
      };

      await chat.save();

      const systemMessage = await ChatMessage.create({
        chat: chat._id,
        senderRole: "system",
        messageType: "system",
        content: `System: Conversation escalated to human support queue (${reason}).`,
        deliveredAt: new Date(),
      });

      if (global.notificationGateway) {
        const roomId = chat._id.toString();

        global.notificationGateway.io.to(`chat:${roomId}`).emit("chat:status:changed", {
          chatId: roomId,
          status: "escalated",
          botActive: false,
          message: "Connecting you to a support agent...",
        });

        global.notificationGateway.io.to(`chat:${roomId}`).emit("chat:message:new", {
          chatId: roomId,
          message: systemMessage.toObject(),
          timestamp: new Date(),
        });

        global.notificationGateway.io.to("admin:notifications").emit("admin:chat:started", {
          chatId: chat._id,
          customerName: "Escalated Customer",
          subject: `Bot Hand-off: ${reason}`,
        });
      }
    } catch (err) {
      console.error("[ORCHESTRATOR] Escalation failed:", err.message);
    }
  }
}

module.exports = new ChatOrchestrator();
