import { buildIndex, saveIndex, search, searchWithGraph } from './agent.js'

function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log('Usage:')
    console.log('  node dist/main.js <repo_path>')
    console.log('  node dist/main.js <repo_path> <query>')
    console.log('')
    console.log('Examples:')
    console.log('  node dist/main.js .')
    console.log('  node dist/main.js . "authentication"')
    console.log('  node dist/main.js /path/to/repo "database connection"')
    process.exit(1)
  }

  const repoPath = args[0]
  const query = args[1]

  try {
    const index = buildIndex(repoPath)

    saveIndex('repository_index.json')

    if (query) {
      console.log('\n' + '='.repeat(60))
      const results = search(query, 10)

      if (results.length > 0) {
        console.log('\n' + '='.repeat(60))
        const graphFiles = searchWithGraph(query, 5, 1)

        console.log('Files to provide as context to LLM:')
        graphFiles.forEach((file, index) => {
          console.log(`  ${index + 1}. ${file}`)
        })
      }
    } else {
      console.log('\nIndex saved to repository_index.json')
      console.log('You can now run searches by providing a query as the second argument.')
      console.log('Example: node dist/main.js . "authentication"')
    }
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

main()
