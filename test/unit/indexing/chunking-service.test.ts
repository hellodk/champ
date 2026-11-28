/**
 * TDD: Tests for ChunkingService.
 * AST-aware chunking using tree-sitter.
 */
import { describe, it, expect } from "vitest";
import { ChunkingService } from "@/indexing/chunking-service";
import type { CodeChunk } from "@/indexing/chunking-service";

describe("ChunkingService", () => {
  const service = new ChunkingService();

  it("should chunk TypeScript file into functions and classes", async () => {
    const content = `
import { foo } from './bar';

function hello(name: string): string {
  return \`Hello, \${name}!\`;
}

class MyService {
  private value: number;

  constructor(val: number) {
    this.value = val;
  }

  getValue(): number {
    return this.value;
  }
}

export const main = () => hello('world');
`;

    const chunks = await service.chunkFile("test.ts", content);
    expect(chunks.length).toBeGreaterThan(0);

    const functionChunk = chunks.find((c) => c.symbolName === "hello");
    expect(functionChunk).toBeDefined();
    expect(functionChunk!.chunkType).toBe("function");

    const classChunk = chunks.find((c) => c.symbolName === "MyService");
    expect(classChunk).toBeDefined();
    expect(classChunk!.chunkType).toBe("class");
  });

  it("should include line numbers for each chunk", async () => {
    const content = "function a() {}\nfunction b() {}";
    const chunks = await service.chunkFile("test.ts", content);

    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it("should fall back to sliding window for unsupported languages", async () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const chunks = await service.chunkFile("data.xyz", content);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].chunkType).toBe("block");
  });

  it("should split large functions into sub-chunks", async () => {
    const bigFunction = `function huge() {\n${Array.from({ length: 300 }, (_, i) => `  const x${i} = ${i};`).join("\n")}\n}`;
    const chunks = await service.chunkFile("big.ts", bigFunction);

    // Should split into multiple chunks since > 150 lines
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("should handle empty files", async () => {
    const chunks = await service.chunkFile("empty.ts", "");
    expect(chunks).toHaveLength(0);
  });

  it("should include file path in each chunk", async () => {
    const chunks = await service.chunkFile(
      "src/utils.ts",
      "function test() {}",
    );
    for (const chunk of chunks) {
      expect(chunk.filePath).toBe("src/utils.ts");
    }
  });

  describe("polyglot language support", () => {
    it("should chunk Python functions and classes based on indentation", async () => {
      const pyContent = `import os

def calculate_metrics(data):
    """Docstring explaining metrics."""
    result = []
    for item in data:
        result.append(item * 2)
    return result

class DataProcessor:
    def __init__(self, name):
        self.name = name

    async def process_async(self, payload):
        return {"status": "ok", "name": self.name}
`;
      const chunks = await service.chunkFile("processor.py", pyContent);
      expect(chunks.length).toBeGreaterThan(0);

      const fn = chunks.find((c) => c.symbolName === "calculate_metrics");
      expect(fn).toBeDefined();
      expect(fn?.chunkType).toBe("function");
      expect(fn?.text).toContain("def calculate_metrics");
      expect(fn?.tokenCount).toBeGreaterThan(0);

      const cls = chunks.find((c) => c.symbolName === "DataProcessor");
      expect(cls).toBeDefined();
      expect(cls?.chunkType).toBe("class");
    });

    it("should chunk Go functions, methods, structs and interfaces", async () => {
      const goContent = `package main

type ServerConfig struct {
    Port int
    Host string
}

type Service interface {
    Start() error
    Stop()
}

func NewServer(cfg ServerConfig) *Server {
    return &Server{cfg: cfg}
}

func (s *Server) Start() error {
    return nil
}
`;
      const chunks = await service.chunkFile("server.go", goContent);
      expect(chunks.length).toBeGreaterThan(0);

      const structChunk = chunks.find((c) => c.symbolName === "ServerConfig");
      expect(structChunk).toBeDefined();
      expect(structChunk?.chunkType).toBe("class");

      const ifaceChunk = chunks.find((c) => c.symbolName === "Service");
      expect(ifaceChunk).toBeDefined();

      const fnChunk = chunks.find((c) => c.symbolName === "NewServer");
      expect(fnChunk).toBeDefined();
      expect(fnChunk?.chunkType).toBe("function");

      const methodChunk = chunks.find((c) => c.symbolName === "Start");
      expect(methodChunk).toBeDefined();
    });

    it("should chunk Rust functions, structs, enums and impl blocks", async () => {
      const rsContent = `pub struct Config {
    pub timeout: u64,
}

pub enum NetworkError {
    Timeout,
    Disconnected,
}

impl Config {
    pub fn new() -> Self {
        Config { timeout: 30 }
    }
}

pub async fn connect(cfg: &Config) -> Result<(), NetworkError> {
    Ok(())
}
`;
      const chunks = await service.chunkFile("net.rs", rsContent);
      expect(chunks.length).toBeGreaterThan(0);

      const structChunk = chunks.find((c) => c.symbolName === "Config");
      expect(structChunk).toBeDefined();

      const enumChunk = chunks.find((c) => c.symbolName === "NetworkError");
      expect(enumChunk).toBeDefined();

      const fnChunk = chunks.find((c) => c.symbolName === "connect");
      expect(fnChunk).toBeDefined();
      expect(fnChunk?.chunkType).toBe("function");
    });

    it("should chunk Java classes and methods", async () => {
      const javaContent = `package com.example;

public class OrderService {
    private final String endpoint;

    public OrderService(String endpoint) {
        this.endpoint = endpoint;
    }

    public synchronized Order createOrder(OrderRequest request) throws ServiceException {
        return new Order(request);
    }
}
`;
      const chunks = await service.chunkFile("OrderService.java", javaContent);
      expect(chunks.length).toBeGreaterThan(0);

      const cls = chunks.find((c) => c.symbolName === "OrderService");
      expect(cls).toBeDefined();
      expect(cls?.chunkType).toBe("class");

      const method = chunks.find((c) => c.symbolName === "createOrder");
      expect(method).toBeDefined();
      expect(method?.chunkType).toBe("function");
    });

    it("should chunk Terraform and HCL infrastructure blocks", async () => {
      const tfContent = `terraform {
  required_version = ">= 1.5.0"
}

variable "cluster_name" {
  type    = string
  default = "production"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = {
    Environment = "prod"
  }
}

module "eks" {
  source = "./modules/eks"
  cluster_name = var.cluster_name
}

output "vpc_id" {
  value = aws_vpc.main.id
}
`;
      const chunks = await service.chunkFile("main.tf", tfContent);
      expect(chunks.length).toBeGreaterThan(0);

      const vpc = chunks.find((c) => c.symbolName === "aws_vpc.main");
      expect(vpc).toBeDefined();
      expect(vpc?.chunkType).toBe("block");

      const eks = chunks.find((c) => c.symbolName === "module.eks");
      expect(eks).toBeDefined();

      const output = chunks.find((c) => c.symbolName === "output.vpc_id");
      expect(output).toBeDefined();
    });
  });
});
