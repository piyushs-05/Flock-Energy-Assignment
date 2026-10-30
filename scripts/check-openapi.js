import SwaggerParser from "@apidevtools/swagger-parser";
await SwaggerParser.validate("openapi.json");
console.log("OpenAPI document is valid.");
