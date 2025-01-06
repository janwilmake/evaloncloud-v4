interface ChatMessage {
  role: string;
  content: string;
}

async function chatCompletion(messages: ChatMessage[]) {
  const response = await fetch("https://chatcompletions.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LLM-Base-Path": "https://api.deepseek.com/v1",
      "X-LLM-API-Key": "sk-da20d20fa9ea4046a5722df89929d2d2",
      "X-Output": "codeblock.ts",
    },
    body: JSON.stringify({
      messages,
      model: "deepseek-chat",
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }

  const data = await response.text();
  console.log(
    "system\n\n",
    messages[0].content,
    "user\n\n",
    messages[1].content,
    "result",
    data,
  );
  return data;
}

function runTest(code: string, testCode: string): string {
  try {
    const wrappedCode = `
${code}

${testCode}
`;

    eval(wrappedCode);
    return "test result: ok";
  } catch (error) {
    return error.message;
  }
}

async function generateTests(prompt: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `Generate unit tests for the given prompt in an IIFE that throws if the tests fail. Do not include any import/exports or describe/expect as this is not available. 
        
The tests will run assuming the code is accessible through the function name \`fn\`. Output only the test code without explanation or markdown. Respond with a js codeblock.`,
    },
    {
      role: "user",
      content: prompt,
    },
  ];

  return chatCompletion(messages);
}

async function generateAPI(code: string, prompt: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `Generate an async function called 'api' that implements a REST API for the given function. It must take {method:string,body?:string,headers:{[name:string]:string},url:string}} and return {body,headers,status}. The function 'fn' is available in scope. Prefer a GET endpoint if possible. Output only the implementation code without explanation or markdown, in a js codeblock.`,
    },
    {
      role: "user",
      content: `
Function implementation:
${code}

Original prompt:
${prompt}

Generate the API wrapper function.`,
    },
  ];

  return chatCompletion(messages);
}

export default {
  fetch: async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/endpoint/")) {
        const prompt = decodeURIComponent(url.pathname.slice(10));
        const { code, apiCode } = await generateAllCode(prompt);

        const headers = {};
        req.headers.forEach((value, key) => (headers[key] = value));

        let body = undefined;
        try {
          body = req.text();
        } catch (e) {}

        const result = await eval(`
          (async ()=>{
            ${code}
            ${apiCode}
            const result = await api(${JSON.stringify({
              url: req.url,
              method: req.method,
              body,
              headers,
            })});
            return result;
          })()
        `);

        return new Response(result.body, {
          status: result.status,
          headers: result.headers,
        });
      }

      if (req.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      const prompt = url.searchParams.get("prompt");
      if (!prompt) {
        return new Response("Missing prompt parameter", { status: 400 });
      }

      const result = await generateAllCode(prompt);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          success: false,
          error: error.message,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};

async function generateAllCode(prompt: string) {
  let currentCode = "";
  let lastError = "";
  const maxAttempts = 5;

  const testCode = await generateTests(prompt);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Generate the function implementation to pass the given tests. Do not import/export anything, and the main function should be named 'fn'. Output only the code in ESM javascript within a js codeblock, without explanation or markdown.",
      },
      {
        role: "user",
        content: `
Here is what I need:
${prompt}

The current code is:
${currentCode || "None"}

The test code that needs to pass is:
${testCode}

The error you received was:
${lastError || "None"}

Please update the code to satisfy the tests.`,
      },
    ];

    const generatedCode = await chatCompletion(messages);
    currentCode = generatedCode;

    const testResult = runTest(currentCode, testCode);
    if (testResult === "test result: ok") {
      const apiCode = await generateAPI(currentCode, prompt);
      return {
        success: true,
        code: currentCode,
        tests: testCode,
        apiCode,
        attempts: attempt + 1,
      };
    }

    lastError = testResult;
  }

  throw new Error(`Max attempts reached. Last error: ${lastError}`);
}