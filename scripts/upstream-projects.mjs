import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export function readProjectConfig(path) {
  const config = ts.getParsedCommandLineOfConfigFile(path, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: error => {
      throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
    },
  })
  if (!config || config.errors.length) throw new Error(`invalid upstream compiler configuration: ${path}`)
  return config
}

/** Validate the graph before any build can write, including omitted inputs. */
export function checkProjectGraph(configPath, { sourceRoot, originalRoot, copied }, projects) {
  if (projects.has(configPath)) return
  if (!resolve(configPath).startsWith(sourceRoot + sep)) throw new Error(`upstream project escapes isolation: ${configPath}`)
  projects.add(configPath)
  const config = readProjectConfig(configPath)
  for (const output of [config.options.outDir, config.options.declarationDir, config.options.tsBuildInfoFile]) {
    if (output && !resolve(output).startsWith(sourceRoot + sep)) throw new Error(`upstream output escapes isolation: ${output}`)
  }
  const originalConfig = readProjectConfig(resolve(originalRoot, relative(sourceRoot, configPath)))
  for (const file of originalConfig.fileNames) {
    const name = relative(originalRoot, file).split(sep).join('/')
    if (!copied.has(name)) throw new Error(`required untracked upstream source: ${file}`)
  }
  for (const reference of config.projectReferences ?? []) {
    checkProjectGraph(ts.resolveProjectReferencePath(reference), { sourceRoot, originalRoot, copied }, projects)
  }
}

/** Subpaths use their emitted declaration, rather than the package main type. */
export function projectDeclaration(config, source, packageRoot, manifest, name) {
  if (typeof manifest.types !== 'string') throw new Error(`upstream type entry missing: ${name}`)
  const declaration = ts.getOutputFileNames(config, source, !ts.sys.useCaseSensitiveFileNames)
    .find(output => /\.d\.[cm]?ts$/.test(output))
  if (!declaration) throw new Error(`upstream declaration output missing: ${name}: ${source}`)
  if (name === manifest.name && declaration !== resolve(packageRoot, manifest.types)) {
    throw new Error(`upstream type entry disagrees with compiler output: ${name}`)
  }
  return declaration
}
