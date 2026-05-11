/*  gpu-miner.cu  —  CUDA keccak-256 nonce finder for HASH256
 *
 *  Usage:  ./gpu-miner <challenge_hex_64chars> <difficulty_hex_64chars> [start_nonce]
 *  Output: JSON to stdout on success, status to stderr
 *
 *  Build:  nvcc -O3 -arch=sm_86 -o gpu-miner gpu-miner.cu
 *          (use -arch=sm_70 for V100, sm_86 for RTX 30xx, sm_89 for RTX 40xx)
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <csignal>
#include <time.h>
#include <cuda_runtime.h>

/* ── Byte swap ─────────────────────────────────────────────────────────── */

__host__ __device__ __forceinline__ uint64_t bswap64(uint64_t x) {
#ifdef __CUDA_ARCH__
    return __byte_perm(x, 0, 0x0123);
#else
    return ((x >> 56) & 0xFFULL) | ((x >> 40) & 0xFF00ULL)
         | ((x >> 24) & 0xFF0000ULL) | ((x >> 8)  & 0xFF000000ULL)
         | ((x << 8)  & 0xFF00000000ULL) | ((x << 24) & 0xFF0000000000ULL)
         | ((x << 40) & 0xFF000000000000ULL) | ((x << 56) & 0xFF00000000000000ULL);
#endif
}

/* ── Keccak-f[1600] constants ──────────────────────────────────────────── */

static __constant__ uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL,
    0x800000000000808AULL, 0x8000000080008000ULL,
    0x000000000000808BULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008AULL, 0x0000000000000088ULL,
    0x0000000080008009ULL, 0x000000008000000AULL,
    0x000000008000808BULL, 0x800000000000008BULL,
    0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800AULL, 0x800000008000000AULL,
    0x8000000080008081ULL, 0x8000000000008080ULL,
    0x0000000080000001ULL, 0x8000000080008008ULL
};

static const int RHO[25] = {
     0,  1, 62, 28, 27,
    36, 44,  6, 55, 20,
     3, 10, 43, 25, 39,
    41, 45, 15, 21,  8,
    18,  2, 61, 56, 14
};

static const int PI[25] = {
     0, 10, 20,  5, 15,
    16,  1, 11, 21,  6,
     7, 17,  2, 12, 22,
    23,  8, 18,  3, 13,
    14, 24,  9, 19,  4
};

/* ── Device keccak-f[1600] ─────────────────────────────────────────────── */

__device__ __forceinline__ uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

__device__ void keccak_f1600(uint64_t s[25]) {
    #pragma unroll 1
    for (int r = 0; r < 24; r++) {
        uint64_t C[5], D[5], tmp[25];

        #pragma unroll
        for (int x = 0; x < 5; x++)
            C[x] = s[x] ^ s[x+5] ^ s[x+10] ^ s[x+15] ^ s[x+20];
        #pragma unroll
        for (int x = 0; x < 5; x++)
            D[x] = C[(x+4)%5] ^ rotl64(C[(x+1)%5], 1);
        #pragma unroll
        for (int i = 0; i < 25; i++)
            s[i] ^= D[i % 5];

        #pragma unroll
        for (int i = 0; i < 25; i++)
            tmp[PI[i]] = rotl64(s[i], RHO[i]);

        #pragma unroll
        for (int y = 0; y < 5; y++)
            #pragma unroll
            for (int x = 0; x < 5; x++)
                s[x + 5*y] = tmp[x + 5*y]
                            ^ ((~tmp[(x+1)%5 + 5*y]) & tmp[(x+2)%5 + 5*y]);

        s[0] ^= RC[r];
    }
}

/* ── Host keccak-256 for verification ──────────────────────────────────── */

static void keccak_f1600_host(uint64_t s[25]) {
    static const uint64_t rc[24] = {
        0x0000000000000001ULL, 0x0000000000008082ULL,
        0x800000000000808AULL, 0x8000000080008000ULL,
        0x000000000000808BULL, 0x0000000080000001ULL,
        0x8000000080008081ULL, 0x8000000000008009ULL,
        0x000000000000008AULL, 0x0000000000000088ULL,
        0x0000000080008009ULL, 0x000000008000000AULL,
        0x000000008000808BULL, 0x800000000000008BULL,
        0x8000000000008089ULL, 0x8000000000008003ULL,
        0x8000000000008002ULL, 0x8000000000000080ULL,
        0x000000000000800AULL, 0x800000008000000AULL,
        0x8000000080008081ULL, 0x8000000000008080ULL,
        0x0000000080000001ULL, 0x8000000080008008ULL
    };
    auto rotl = [](uint64_t x, int n) -> uint64_t { return (x << n) | (x >> (64 - n)); };

    for (int r = 0; r < 24; r++) {
        uint64_t C[5], D[5], tmp[25];
        for (int x = 0; x < 5; x++)
            C[x] = s[x] ^ s[x+5] ^ s[x+10] ^ s[x+15] ^ s[x+20];
        for (int x = 0; x < 5; x++)
            D[x] = C[(x+4)%5] ^ rotl(C[(x+1)%5], 1);
        for (int i = 0; i < 25; i++) s[i] ^= D[i % 5];

        for (int i = 0; i < 25; i++)
            tmp[PI[i]] = rotl(s[i], RHO[i]);

        for (int y = 0; y < 5; y++)
            for (int x = 0; x < 5; x++)
                s[x + 5*y] = tmp[x + 5*y]
                            ^ ((~tmp[(x+1)%5 + 5*y]) & tmp[(x+2)%5 + 5*y]);

        s[0] ^= rc[r];
    }
}

static void keccak256_host(const uint8_t* msg, int len, uint8_t out[32]) {
    uint64_t s[25];
    memset(s, 0, 200);

    int rate = 136;
    int off = 0;
    while (off < len) {
        int chunk = len - off;
        if (chunk > rate) chunk = rate;
        for (int i = 0; i < chunk; i++)
            s[i / 8] ^= (uint64_t)msg[off + i] << (8 * (i % 8));
        off += chunk;
        if (off % rate == 0) keccak_f1600_host(s);
    }

    int pad_start = len % rate;
    s[pad_start / 8] ^= (uint64_t)0x01 << (8 * (pad_start % 8));
    s[(rate - 1) / 8] ^= (uint64_t)0x80 << (8 * ((rate - 1) % 8));
    keccak_f1600_host(s);

    for (int i = 0; i < 4; i++) {
        uint64_t v = s[i];
        out[i*8+0] = v;       out[i*8+1] = v >> 8;
        out[i*8+2] = v >> 16; out[i*8+3] = v >> 24;
        out[i*8+4] = v >> 32; out[i*8+5] = v >> 40;
        out[i*8+6] = v >> 48; out[i*8+7] = v >> 56;
    }
}

/* ── Hex helpers ───────────────────────────────────────────────────────── */

static uint8_t hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
}

static void hex_to_bytes(const char* hex, uint8_t* out, int n) {
    if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
    for (int i = 0; i < n; i++)
        out[i] = (hex_nibble(hex[i*2]) << 4) | hex_nibble(hex[i*2+1]);
}

static uint64_t bytes_to_u64_le(const uint8_t* b) {
    return (uint64_t)b[0]       | ((uint64_t)b[1] << 8)
         | ((uint64_t)b[2] << 16) | ((uint64_t)b[3] << 24)
         | ((uint64_t)b[4] << 32) | ((uint64_t)b[5] << 40)
         | ((uint64_t)b[6] << 48) | ((uint64_t)b[7] << 56);
}

static uint64_t bytes_to_u64_be(const uint8_t* b) {
    return ((uint64_t)b[0] << 56) | ((uint64_t)b[1] << 48)
         | ((uint64_t)b[2] << 40) | ((uint64_t)b[3] << 32)
         | ((uint64_t)b[4] << 24) | ((uint64_t)b[5] << 16)
         | ((uint64_t)b[6] << 8)  | ((uint64_t)b[7]);
}

/* ── CUDA Mining Kernel ────────────────────────────────────────────────── */

__global__ void mine_kernel(
    const uint64_t* __restrict__ pre_state,   /* 25 lanes (pre-absorbed) */
    const uint64_t* __restrict__ diff_be,      /* 4 lanes, big-endian */
    uint64_t start_nonce,
    volatile uint64_t* __restrict__ result_nonce,
    volatile int* __restrict__ result_flag,
    uint64_t batch_size
) {
    uint64_t idx = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= batch_size) return;
    if (*result_flag) return;  /* early exit if another thread found it */

    uint64_t nonce = start_nonce + idx;

    /* Copy pre-computed state and set nonce (lane 7 = nonce BE) */
    uint64_t s[25];
    #pragma unroll
    for (int i = 0; i < 25; i++) s[i] = pre_state[i];
    s[7] = bswap64(nonce);

    /* Run keccak-f[1600] */
    keccak_f1600(s);

    /* Compare hash < difficulty (big-endian 256-bit) */
    uint64_t h0 = bswap64(s[0]);
    if (h0 > diff_be[0]) return;
    if (h0 < diff_be[0]) goto found;

    uint64_t h1 = bswap64(s[1]);
    if (h1 > diff_be[1]) return;
    if (h1 < diff_be[1]) goto found;

    uint64_t h2 = bswap64(s[2]);
    if (h2 > diff_be[2]) return;
    if (h2 < diff_be[2]) goto found;

    uint64_t h3 = bswap64(s[3]);
    if (h3 >= diff_be[3]) return;

found:
    atomicExch((unsigned long long*)result_nonce, (unsigned long long)nonce);
    atomicExch((int*)result_flag, 1);
}

/* ── Main ──────────────────────────────────────────────────────────────── */

static volatile int g_stop = 0;
static void sig_handler(int) { g_stop = 1; }

int main(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr,
            "Usage: %s <challenge_hex_64chars> <difficulty_hex_64chars> [start_nonce]\n"
            "\n"
            "GPU-accelerated keccak-256 nonce finder for HASH256 mining.\n"
            "Outputs JSON to stdout when solution found.\n",
            argv[0]);
        return 1;
    }

    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    /* Parse inputs */
    uint8_t challenge[32], diff_bytes[32];
    hex_to_bytes(argv[1], challenge, 32);
    hex_to_bytes(argv[2], diff_bytes, 32);

    uint64_t start_nonce = 0;
    if (argc > 3) start_nonce = strtoull(argv[3], NULL, 10);

    /* Verify keccak-256 implementation */
    {
        uint8_t test_msg[64] = {0};
        test_msg[0] = 0xab;
        uint8_t test_hash[32];
        keccak256_host(test_msg, 64, test_hash);
        fprintf(stderr, "[gpu-miner] keccak256 verification: ");
        for (int i = 0; i < 8; i++) fprintf(stderr, "%02x", test_hash[i]);
        fprintf(stderr, "...\n");
    }

    /*
     * Pre-compute keccak state from the 64-byte message layout:
     *   bytes 0-31: challenge (lanes 0-3)
     *   bytes 32-63: nonce as big-endian uint256 (lanes 4-7)
     *     lanes 4-6 = 0 (nonce < 2^64)
     *     lane 7 = bswap64(nonce)  <-- set per-thread in kernel
     *
     * Padding (single-block, 64 bytes < rate=136):
     *   byte 64 = 0x01 → lane 8, bit 0
     *   byte 135 = 0x80 → lane 16, MSB
     */
    uint64_t pre_state[25];
    memset(pre_state, 0, 200);
    for (int i = 0; i < 4; i++)
        pre_state[i] = bytes_to_u64_le(challenge + i * 8);
    /* lanes 4-6 = 0 (already zero) */
    /* lane 7 = 0 (set per nonce in kernel) */
    pre_state[8]  ^= 0x01ULL;
    pre_state[16] ^= 0x8000000000000000ULL;

    /* Build difficulty as 4 big-endian uint64 lanes */
    uint64_t diff_be[4];
    for (int i = 0; i < 4; i++)
        diff_be[i] = bytes_to_u64_be(diff_bytes + i * 8);

    /* Select GPU */
    int dev_count = 0;
    cudaGetDeviceCount(&dev_count);
    if (dev_count == 0) {
        fprintf(stderr, "[gpu-miner] ERROR: No CUDA devices found!\n");
        return 1;
    }

    int best_dev = 0;
    int best_sm = 0;
    for (int d = 0; d < dev_count; d++) {
        cudaDeviceProp prop;
        cudaGetDeviceProperties(&prop, d);
        fprintf(stderr, "[gpu-miner] GPU %d: %s (SM %d.%d, %d SMs, %.0f MHz, %zu MB VRAM)\n",
                d, prop.name, prop.major, prop.minor,
                prop.multiProcessorCount, prop.clockRate / 1000.0,
                prop.totalGlobalMem / 1048576UL);
        if (prop.multiProcessorCount > best_sm) {
            best_sm = prop.multiProcessorCount;
            best_dev = d;
        }
    }

    cudaSetDevice(best_dev);
    cudaDeviceProp prop;
    cudaGetDeviceProperties(&prop, best_dev);
    fprintf(stderr, "[gpu-miner] Using: %s (%d SMs)\n\n", prop.name, prop.multiProcessorCount);

    /* Kernel configuration */
    int threads = 256;
    uint64_t grid_size = (uint64_t)prop.multiProcessorCount * 64;
    uint64_t batch_size = grid_size * threads;
    if (batch_size > 33554432ULL) batch_size = 33554432ULL;
    grid_size = (batch_size + threads - 1) / threads;

    fprintf(stderr, "╔═══════════════════════════════════════════════════════════════╗\n");
    fprintf(stderr, "║  HASH256 GPU Miner                                          ║\n");
    fprintf(stderr, "║  Device: %-48s ║\n", prop.name);
    fprintf(stderr, "║  Batch:  %-48llu ║\n", (unsigned long long)batch_size);
    fprintf(stderr, "╚═══════════════════════════════════════════════════════════════╝\n\n");

    /* Allocate device memory */
    uint64_t *d_pre, *d_diff, *d_nonce;
    int *d_flag;

    cudaMalloc(&d_pre, 25 * 8);
    cudaMalloc(&d_diff, 4 * 8);
    cudaMalloc(&d_nonce, 8);
    cudaMalloc(&d_flag, 4);

    cudaMemcpy(d_pre, pre_state, 25 * 8, cudaMemcpyHostToDevice);
    cudaMemcpy(d_diff, diff_be, 4 * 8, cudaMemcpyHostToDevice);

    fprintf(stderr, "[gpu-miner] Mining started. Ctrl+C to stop.\n\n");

    /* Mining loop */
    uint64_t nonce = start_nonce;
    uint64_t total_checked = 0;
    int found_any = 0;
    int rounds = 0;
    struct timespec t_start, t_now;
    clock_gettime(CLOCK_MONOTONIC, &t_start);

    while (!g_stop) {
        cudaMemset(d_nonce, 0, 8);
        cudaMemset(d_flag, 0, 4);

        mine_kernel<<<(int)grid_size, threads>>>(
            d_pre, d_diff, nonce, d_nonce, d_flag, batch_size
        );

        cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            fprintf(stderr, "\n[gpu-miner] CUDA error: %s\n", cudaGetErrorString(err));
            break;
        }

        cudaDeviceSynchronize();

        int found = 0;
        cudaMemcpy(&found, d_flag, 4, cudaMemcpyDeviceToHost);

        total_checked += batch_size;
        nonce += batch_size;
        rounds++;

        /* Print status every ~5 seconds */
        if (rounds % 20 == 0 || found) {
            clock_gettime(CLOCK_MONOTONIC, &t_now);
            double elapsed = (t_now.tv_sec - t_start.tv_sec)
                           + (t_now.tv_nsec - t_start.tv_nsec) / 1e9;
            double rate = total_checked / elapsed;
            const char* unit = "H/s";
            if (rate >= 1e9)      { rate /= 1e9; unit = "GH/s"; }
            else if (rate >= 1e6) { rate /= 1e6; unit = "MH/s"; }
            else if (rate >= 1e3) { rate /= 1e3; unit = "KH/s"; }

            fprintf(stderr, "\r[gpu-miner] ⛏  %.2f %s | Checked: %llu | Nonce: %llu   ",
                    rate, unit,
                    (unsigned long long)total_checked,
                    (unsigned long long)nonce);
        }

        if (found) {
            uint64_t result;
            cudaMemcpy(&result, d_nonce, 8, cudaMemcpyDeviceToHost);

            /* Verify: compute hash on host */
            uint8_t msg[64];
            memcpy(msg, challenge, 32);
            /* nonce as big-endian uint256 in bytes 32-63 */
            memset(msg + 32, 0, 24);
            for (int i = 0; i < 8; i++)
                msg[63 - i] = (result >> (i * 8)) & 0xFF;
            uint8_t hash[32];
            keccak256_host(msg, 64, hash);

            char hash_hex[65];
            for (int i = 0; i < 32; i++)
                sprintf(hash_hex + i * 2, "%02x", hash[i]);
            hash_hex[64] = 0;

            fprintf(stderr, "\n\n[gpu-miner] ✅ FOUND! nonce=%llu\n", (unsigned long long)result);
            fprintf(stderr, "[gpu-miner] hash=0x%s\n", hash_hex);

            /* JSON to stdout for wrapper script */
            printf("{\"found\":true,\"nonce\":\"%llu\",\"hash\":\"0x%s\"}\n",
                   (unsigned long long)result, hash_hex);
            fflush(stdout);

            found_any = 1;
            break;
        }
    }

    if (!found_any) {
        fprintf(stderr, "\n[gpu-miner] Batch complete, no solution. Total: %llu\n",
                (unsigned long long)total_checked);
        printf("{\"found\":false}\n");
        fflush(stdout);
    }

    cudaFree(d_pre);
    cudaFree(d_diff);
    cudaFree(d_nonce);
    cudaFree(d_flag);
    cudaDeviceReset();

    return found_any ? 0 : 1;
}
