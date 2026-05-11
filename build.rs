// On Windows MSVC, the OpenCL ICD ships only as OpenCL.dll — the matching
// OpenCL.lib import library isn't installed by NVIDIA/AMD drivers, so the
// `cl-sys` crate (used by `ocl`) fails to link. We vendor a locally-generated
// OpenCL.lib under vendor/ and point the linker at it.
fn main() {
    if std::env::var("CARGO_FEATURE_GPU").is_ok() {
        let target = std::env::var("TARGET").unwrap_or_default();
        if target.contains("windows") && target.contains("msvc") {
            let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
            println!("cargo:rustc-link-search=native={manifest_dir}/vendor");
            println!("cargo:rerun-if-changed=vendor/OpenCL.lib");
        }
    }
}
