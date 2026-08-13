export interface AfterPackContext {
    readonly electronPlatformName: string;
    readonly appOutDir: string;
    readonly arch: number;
    readonly packager: {
        readonly appInfo: {
            readonly productFilename: string;
        };
    };
}

export function pe_machine(file_path: string): Promise<number | undefined>;
export default function after_pack(context: AfterPackContext): Promise<void>;
