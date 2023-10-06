import {defineConfig, Plugin} from "vite";
import glob from "fast-glob";
import fs from 'fs';
import path from 'path';

/** ソースファイルの置き場 */
const lessSource = 'less';
/** 一時出力先 */
const outDir = 'tmp/vite';
/** フィーチャーフラグ付きのlessを作成先ディレクトリ */
const featureFlagDir = 'less/features';
export default defineConfig(() => {

    return {
        build: {
            manifest: true,
            outDir,
            rollupOptions: {
                /*
                 * lessコンパイルのルール
                 * - less/以下の.lessをコンパイルする
                 * - ただし，_から始まるファイルはコンパイルしない
                 */
                input: glob.sync([`${lessSource}/**/*.less`, `!${featureFlagDir}/**/*.less`, '!**/_*']),
            },
        },
        css: {
            preprocessorOptions: {
                less: {},
            }
        },
        plugins: [featureFlags(), copyAssets()],
    }
});

interface FlagsToLessProps {
    sourceLessPath: string;
    targetLessPath: string;
    flags: string[];
}

/**
 * Viteのビルド開始前に、フィーチャーフラグ用の変数を付与した`.less`ファイルを作成し、そのファイルをビルド対象にする
 */
function featureFlags(): Plugin {
    return {
        name: 'feature-flags',
        async options(inputOption) {
            const {
                default: {featureFlags, styles},
            } = await import('./config/feature-flags.json');
            const flags = Object.keys(featureFlags);
            await Promise.all(glob.sync(`${featureFlagDir}/**/*.less`).map((e) => fs.promises.unlink(e)));

            /**
             * フラグを受け取ってそのフラグが定義されたlessを吐き出す
             */
            const flagsToLess = async ({sourceLessPath, targetLessPath, flags}: FlagsToLessProps) => {
                const flagVariantsLess = flags.map(
                    (e) =>
                        // language=less
                        `@${e}: true;`,
                );

                const styleSource = [
                    ...flagVariantsLess,
                    // language=less
                    `@import '${sourceLessPath}';`,
                ].join('\n');
                await fs.promises.mkdir(path.dirname(targetLessPath), {recursive: true});
                await fs.promises.writeFile(targetLessPath, styleSource);
                // Viteのdevサーバー実行時にはinfoが入っていない
                this.info?.(`${sourceLessPath} to ${targetLessPath} is activated`);
            };

            await Promise.all(
                styles
                    .map((sourceLessPath) => [
                        ...flags.map((flag) =>
                            flagsToLess({
                                targetLessPath: `${featureFlagDir}/${flag}/${sourceLessPath.slice(lessSource.length + 1)}`,
                                sourceLessPath,
                                flags: [flag],
                            }),
                        ),
                        flagsToLess({
                            targetLessPath: `${featureFlagDir}/all/${sourceLessPath.slice(lessSource.length + 1)}`,
                            sourceLessPath,
                            flags,
                        }),
                    ])
                    .flat(),
            );


            const {input} = inputOption;
            const flaggedStyles = glob.sync([`${featureFlagDir}/**/*.less`]);
            if (typeof input == 'string') {
                inputOption.input = [input, ...flaggedStyles];
            } else if (Array.isArray(input)) {
                inputOption.input = [...input, ...flaggedStyles];
            } else if (input && typeof input == 'object') {
                flaggedStyles.map((e) => {
                    input[e] = e;
                });
                inputOption.input = input;
            }
            return inputOption;
        },
    };
}

/**
 * Viteのビルド完了後、manifest.jsonの内容に沿ってビルドされたCSSをstatic/css配下にコピーする
 */
function copyAssets(): Plugin {
    return {
        name: 'copy-assets',
        async closeBundle() {
            // 動的にrequireをしているから、jsonから型情報を読み取れないので、明示する
            const manifest: Record<
                string,
                {
                    file: string;
                    isEntry: boolean;
                    src: string;
                }
            > = require(`./${outDir}/manifest.json`);

            const matcher = new RegExp(`^${lessSource}\/(?<path>.*)\.less`);
            await Promise.all(
                Object.entries(manifest).map(async ([key, entry]) => {
                    const matches = key.match(matcher);
                    if (!matches?.groups?.path) return;
                    const targetPath = `static/css/${matches.groups.path}.css`;
                    await fs.promises.mkdir(path.dirname(targetPath), {recursive: true});
                    await fs.promises.copyFile(`${outDir}/${entry.file}`, targetPath);
                    this.info?.(`copied asset: ${entry.file} to ${targetPath}`);
                }),
            );
        },
    };
}