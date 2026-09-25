import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default generateEslintConfig({
	enableTypescript: true,
	ignores: ['tools/**'], // hardware rigs: plain scripts, run by hand, not shipped
})
