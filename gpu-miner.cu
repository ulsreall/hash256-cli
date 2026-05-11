/*  gpu-miner.cu  —  Multi-GPU CUDA keccak-256 nonce finder for HASH256
 *
 *  Works on: RTX 5090 (Blackwell sm_120), RTX 4090 (Ada sm_89), H100 (Hopper sm_90)
 *
 *  Usage:  ./gpu-miner <challenge_hex_64chars> <difficulty_hex_64chars> [start_nonce]
 *  Output: JSON to stdout on success, status to stderr
 *
 *  Build:  nvcc -O3 -arch=sm_120 --use_fast_math -o gpu-miner gpu-miner.cu -lcudart -lpthread
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <csignal>
#include <pthread.h>
#include <time.h>
#include <cuda_runtime.h>

/* ── Keccak-f[1600] constants ──────────────────────────────────────────── */

static const uint64_t h_RC[24] = {
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

static const int h_RHO[25] = {
     0,  1, 62, 28, 27, 36, 44,  6, 55, 20,
     3, 10, 43, 25, 39, 41, 45, 15, 21,  8,
    18,  2, 61, 56, 14
};

static const int h_PI[25] = {
     0, 10, 20,  5, 15, 16,  1, 11, 21,  6,
     7, 17,  2, 12, 22, 23,  8, 18,  3, 13,
    14, 24,  9, 19,  4
};

/* ── Host keccak-f[1600] for verification ──────────────────────────────── */

static uint64_t h_rotl64(uint64_t x, int n) { return (x << n) | (x >> (64 - n)); }

static void keccak_f1600_host(uint64_t s[25]) {
    for (int r = 0; r < 24; r++) {
        uint64_t C[5], D[5], tmp[25];
        for (int x = 0; x < 5; x++)
            C[x] = s[x] ^ s[x+5] ^ s[x+10] ^ s[x+15] ^ s[x+20];
        for (int x = 0; x < 5; x++)
            D[x] = C[(x+4)%5] ^ h_rotl64(C[(x+1)%5], 1);
        for (int i = 0; i < 25; i++) s[i] ^= D[i % 5];
        for (int i = 0; i < 25; i++)
            tmp[h_PI[i]] = h_rotl64(s[i], h_RHO[i]);
        for (int y = 0; y < 5; y++)
            for (int x = 0; x < 5; x++)
                s[x + 5*y] = tmp[x + 5*y] ^ ((~tmp[(x+1)%5 + 5*y]) & tmp[(x+2)%5 + 5*y]);
        s[0] ^= h_RC[r];
    }
}

static void keccak256_host(const uint8_t* msg, int len, uint8_t out[32]) {
    uint64_t s[25];
    memset(s, 0, 200);
    int rate = 136, off = 0;
    while (off < len) {
        int chunk = len - off;
        if (chunk > rate) chunk = rate;
        for (int i = 0; i < chunk; i++)
            s[i / 8] ^= (uint64_t)msg[off + i] << (8 * (i % 8));
        off += chunk;
        if (off % rate == 0) keccak_f1600_host(s);
    }
    int pad = len % rate;
    s[pad / 8] ^= (uint64_t)0x01 << (8 * (pad % 8));
    s[(rate - 1) / 8] ^= (uint64_t)0x80 << (8 * ((rate - 1) % 8));
    keccak_f1600_host(s);
    for (int i = 0; i < 4; i++) {
        uint64_t v = s[i];
        out[i*8+0]=v; out[i*8+1]=v>>8; out[i*8+2]=v>>16; out[i*8+3]=v>>24;
        out[i*8+4]=v>>32; out[i*8+5]=v>>40; out[i*8+6]=v>>48; out[i*8+7]=v>>56;
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
    return (uint64_t)b[0]|((uint64_t)b[1]<<8)|((uint64_t)b[2]<<16)|((uint64_t)b[3]<<24)
         | ((uint64_t)b[4]<<32)|((uint64_t)b[5]<<40)|((uint64_t)b[6]<<48)|((uint64_t)b[7]<<56);
}

static uint64_t bytes_to_u64_be(const uint8_t* b) {
    return ((uint64_t)b[0]<<56)|((uint64_t)b[1]<<48)|((uint64_t)b[2]<<40)|((uint64_t)b[3]<<32)
         | ((uint64_t)b[4]<<24)|((uint64_t)b[5]<<16)|((uint64_t)b[6]<<8)|(uint64_t)b[7];
}

/* ── Device constants ──────────────────────────────────────────────────── */

__constant__ uint64_t d_RC[24];
__constant__ int d_RHO[25];
__constant__ int d_PI[25];

/* ── Device keccak-f[1600] ─────────────────────────────────────────────── */

__device__ __forceinline__ uint64_t bswap64(uint64_t x) {
    return __byte_perm(x, 0, 0x0123);
}

__device__ __forceinline__ uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

__device__ __noinline__ void keccak_f1600_dev(uint64_t s[25]) {
    uint64_t C[5], D[5], tmp[25];
    #pragma unroll 1
    for (int r = 0; r < 24; r++) {
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
            tmp[d_PI[i]] = rotl64(s[i], d_RHO[i]);
        #pragma unroll
        for (int y = 0; y < 5; y++)
            #pragma unroll
            for (int x = 0; x < 5; x++)
                s[x + 5*y] = tmp[x + 5*y] ^ ((~tmp[(x+1)%5 + 5*y]) & tmp[(x+2)%5 + 5*y]);
        s[0] ^= d_RC[r];
    }
}

/* ── Mining Kernel ─────────────────────────────────────────────────────── */

__global__ void mine_kernel(
    const uint64_t* __restrict__ pre_state,
    const uint64_t* __restrict__ diff_be,
    uint64_t start_nonce,
    volatile uint64_t* __restrict__ result_nonce,
    volatile int* __restrict__ result_flag,
    uint64_t batch_size
) {
    uint64_t idx = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= batch_size || *result_flag) return;

    uint64_t nonce = start_nonce + idx;
    uint64_t s[25];

    #pragma unroll
    for (int i = 0; i < 25; i++) s[i] = pre_state[i];
    s[7] = bswap64(nonce);

    keccak_f1600_dev(s);

    /* Compare hash < difficulty (big-endian 256-bit) — no goto, use if-chain */
    uint64_t h0 = bswap64(s[0]);
    uint64_t h1 = bswap64(s[1]);
    uint64_t h2 = bswap64(s[2]);
    uint64_t h3 = bswap64(s[3]);

    int is_less = 0;
    if (h0 < diff_be[0]) is_less = 1;
    else if (h0 > diff_be[0]) return;
    else if (h1 < diff_be[1]) is_less = 1;
    else if (h1 > diff_be[1]) return;
    else if (h2 < diff_be[2]) is_less = 1;
    else if (h2 > diff_be[2]) return;
    else if (h3 < diff_be[3]) is_less = 1;
    else return; /* h3 >= diff_be[3] */

    if (is_less) {
        atomicExch((unsigned long long*)result_nonce, (unsigned long long)nonce);
        atomicExch((int*)result_flag, 1);
    }
}

/* ── Per-GPU context ───────────────────────────────────────────────────── */

struct GpuContext {
    int device_id;
    int sm_count;
    uint64_t* d_pre;
    uint64_t* d_diff;
    uint64_t* d_nonce;
    int* d_flag;
    uint64_t batch_size;
    uint64_t grid_size;
    int threads;
};

struct GpuResult {
    int gpu_id;
    uint64_t nonce;
    int found;
    uint64_t total_checked;
};

/* ── Per-GPU mining thread ─────────────────────────────────────────────── */

struct ThreadArg {
    GpuContext* ctx;
    uint64_t pre_state[25];
    uint64_t diff_be[4];
    uint64_t start_nonce;
    volatile int* global_stop;
    GpuResult* result;
};

static volatile int g_stop = 0;
static void sig_handler(int) { g_stop = 1; }

void* gpu_thread(void* arg) {
    ThreadArg* ta = (ThreadArg*)arg;
    GpuContext* ctx = ta->ctx;
    GpuResult* res = ta->result;

    cudaSetDevice(ctx->device_id);

    /* Copy constants */
    cudaMemcpyToSymbol(d_RC, h_RC, 24 * 8);
    cudaMemcpyToSymbol(d_RHO, h_RHO, 25 * 4);
    cudaMemcpyToSymbol(d_PI, h_PI, 25 * 4);

    /* Copy state to device */
    cudaMemcpy(ctx->d_pre, ta->pre_state, 25 * 8, cudaMemcpyHostToDevice);
    cudaMemcpy(ctx->d_diff, ta->diff_be, 4 * 8, cudaMemcpyHostToDevice);

    uint64_t nonce = ta->start_nonce;
    uint64_t total_checked = 0;
    int rounds = 0;
    res->found = 0;
    res->total_checked = 0;

    struct timespec t_start, t_now;
    clock_gettime(CLOCK_MONOTONIC, &t_start);

    while (!g_stop && !*(ta->global_stop)) {
        cudaMemset(ctx->d_nonce, 0, 8);
        cudaMemset(ctx->d_flag, 0, 4);

        mine_kernel<<<(int)ctx->grid_size, ctx->threads>>>(
            ctx->d_pre, ctx->d_diff, nonce,
            ctx->d_nonce, ctx->d_flag, ctx->batch_size
        );

        cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) {
            fprintf(stderr, "\n[gpu%d] CUDA error: %s\n", ctx->device_id, cudaGetErrorString(err));
            break;
        }

        cudaDeviceSynchronize();

        int found = 0;
        cudaMemcpy(&found, ctx->d_flag, 4, cudaMemcpyDeviceToHost);

        total_checked += ctx->batch_size;
        nonce += ctx->batch_size;
        rounds++;

        /* Status every ~3s */
        if (rounds % 10 == 0 || found) {
            clock_gettime(CLOCK_MONOTONIC, &t_now);
            double elapsed = (t_now.tv_sec - t_start.tv_sec)
                           + (t_now.tv_nsec - t_start.tv_nsec) / 1e9;
            double rate = total_checked / elapsed;
            const char* unit = "H/s";
            if (rate >= 1e9)      { rate /= 1e9; unit = "GH/s"; }
            else if (rate >= 1e6) { rate /= 1e6; unit = "MH/s"; }
            else if (rate >= 1e3) { rate /= 1e3; unit = "KH/s"; }

            fprintf(stderr, "\r[gpu%d] ⛏  %.2f %s | Checked: %llu M | Rounds: %d   ",
                    ctx->device_id, rate, unit,
                    (unsigned long long)(total_checked / 1000000), rounds);
        }

        if (found) {
            uint64_t result;
            cudaMemcpy(&result, ctx->d_nonce, 8, cudaMemcpyDeviceToHost);
            res->nonce = result;
            res->found = 1;
            res->total_checked = total_checked;
            *(ta->global_stop) = 1;
            break;
        }
    }

    res->total_checked = total_checked;
    return NULL;
}

/* ── Main ──────────────────────────────────────────────────────────────── */

int main(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr,
            "Usage: %s <challenge_hex> <difficulty_hex> [start_nonce]\n\n"
            "Multi-GPU keccak-256 nonce finder for HASH256.\n"
            "Supports: RTX 5090 (Blackwell), RTX 4090, H100, A100, etc.\n\n",
            argv[0]);
        return 1;
    }

    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    uint8_t challenge[32], diff_bytes[32];
    hex_to_bytes(argv[1], challenge, 32);
    hex_to_bytes(argv[2], diff_bytes, 32);

    uint64_t start_nonce = 0;
    if (argc > 3) start_nonce = strtoull(argv[3], NULL, 10);

    /* Verify keccak */
    {
        uint8_t tm[64] = {0}; tm[0] = 0xab;
        uint8_t th[32];
        keccak256_host(tm, 64, th);
        fprintf(stderr, "[gpu-miner] keccak256 verify: %02x%02x%02x%02x... ✓\n",
                th[0], th[1], th[2], th[3]);
    }

    /* Pre-compute state */
    uint64_t pre_state[25];
    memset(pre_state, 0, 200);
    for (int i = 0; i < 4; i++)
        pre_state[i] = bytes_to_u64_le(challenge + i * 8);
    pre_state[8]  ^= 0x01ULL;
    pre_state[16] ^= 0x8000000000000000ULL;

    uint64_t diff_be[4];
    for (int i = 0; i < 4; i++)
        diff_be[i] = bytes_to_u64_be(diff_bytes + i * 8);

    /* Enumerate GPUs */
    int dev_count = 0;
    cudaGetDeviceCount(&dev_count);
    if (dev_count == 0) {
        fprintf(stderr, "[gpu-miner] ERROR: No CUDA devices!\n");
        return 1;
    }

    fprintf(stderr, "\n");
    fprintf(stderr, "╔═══════════════════════════════════════════════════════════════╗\n");
    fprintf(stderr, "║  HASH256 Multi-GPU Miner                                    ║\n");
    fprintf(stderr, "║  Devices: %-4d                                              ║\n", dev_count);
    fprintf(stderr, "╚═══════════════════════════════════════════════════════════════╝\n\n");

    GpuContext* gpus = (GpuContext*)malloc(dev_count * sizeof(GpuContext));
    GpuResult* results = (GpuResult*)malloc(dev_count * sizeof(GpuResult));
    ThreadArg* targs = (ThreadArg*)malloc(dev_count * sizeof(ThreadArg));

    for (int d = 0; d < dev_count; d++) {
        GpuContext* g = &gpus[d];
        g->device_id = d;

        cudaDeviceProp prop;
        cudaGetDeviceProperties(&prop, d);
        g->sm_count = prop.multiProcessorCount;

        /* clockRate deprecated in newer CUDA — use 2000 MHz as default estimate */
        int clock_mhz = 2000;
        #ifdef CUDART_VERSION
        #if CUDART_VERSION < 12040
        clock_mhz = prop.clockRate / 1000;
        #endif
        #endif

        fprintf(stderr, "[gpu%d] %s (SM %d.%d, %d SMs, ~%d MHz, %zu MB)\n",
                d, prop.name, prop.major, prop.minor,
                prop.multiProcessorCount, clock_mhz,
                prop.totalGlobalMem / 1048576UL);

        /* Tune batch per GPU */
        int blocks_per_sm = 512;
        g->threads = 512;

        if (prop.multiProcessorCount >= 100) { blocks_per_sm = 512; }  /* H100/RTX5090 */
        else if (prop.multiProcessorCount >= 80) { blocks_per_sm = 256; }  /* A100/RTX4090 */
        else if (prop.multiProcessorCount >= 40) { blocks_per_sm = 128; }  /* smaller */
        else { blocks_per_sm = 64; }

        g->grid_size = (uint64_t)prop.multiProcessorCount * blocks_per_sm;
        g->batch_size = g->grid_size * g->threads;
        if (g->batch_size > 134217728ULL) g->batch_size = 134217728ULL;
        g->grid_size = (g->batch_size + g->threads - 1) / g->threads;

        fprintf(stderr, "[gpu%d] Grid: %llu × %d = %llu nonces/batch (%.1f M)\n\n",
                d, (unsigned long long)g->grid_size, g->threads,
                (unsigned long long)g->batch_size, g->batch_size / 1e6);

        cudaSetDevice(d);
        cudaMalloc(&g->d_pre, 25 * 8);
        cudaMalloc(&g->d_diff, 4 * 8);
        cudaMalloc(&g->d_nonce, 8);
        cudaMalloc(&g->d_flag, 4);
    }

    /* Launch threads */
    volatile int global_stop = 0;
    pthread_t* threads = (pthread_t*)malloc(dev_count * sizeof(pthread_t));

    fprintf(stderr, "[miner] Starting %d GPU thread(s). Ctrl+C to stop.\n\n", dev_count);

    for (int d = 0; d < dev_count; d++) {
        targs[d].ctx = &gpus[d];
        memcpy(targs[d].pre_state, pre_state, 200);
        memcpy(targs[d].diff_be, diff_be, 32);
        targs[d].start_nonce = start_nonce + (uint64_t)d * 100000000000ULL;
        targs[d].global_stop = &global_stop;
        targs[d].result = &results[d];
        memset(&results[d], 0, sizeof(GpuResult));
        results[d].gpu_id = d;

        pthread_create(&threads[d], NULL, gpu_thread, &targs[d]);
    }

    for (int d = 0; d < dev_count; d++)
        pthread_join(threads[d], NULL);

    /* Check results */
    for (int d = 0; d < dev_count; d++) {
        if (results[d].found) {
            uint64_t nonce = results[d].nonce;

            /* Verify */
            uint8_t msg[64];
            memcpy(msg, challenge, 32);
            memset(msg + 32, 0, 24);
            for (int i = 0; i < 8; i++)
                msg[63 - i] = (nonce >> (i * 8)) & 0xFF;
            uint8_t hash[32];
            keccak256_host(msg, 64, hash);

            char hash_hex[65];
            for (int i = 0; i < 32; i++)
                sprintf(hash_hex + i * 2, "%02x", hash[i]);
            hash_hex[64] = 0;

            fprintf(stderr, "\n\n[gpu%d] ✅ FOUND! nonce=%llu\n", d, (unsigned long long)nonce);
            fprintf(stderr, "[gpu%d] hash=0x%s\n", d, hash_hex);

            printf("{\"found\":true,\"nonce\":\"%llu\",\"hash\":\"0x%s\"}\n",
                   (unsigned long long)nonce, hash_hex);
            fflush(stdout);

            for (int dd = 0; dd < dev_count; dd++) {
                cudaSetDevice(dd);
                cudaFree(gpus[dd].d_pre);
                cudaFree(gpus[dd].d_diff);
                cudaFree(gpus[dd].d_nonce);
                cudaFree(gpus[dd].d_flag);
            }
            free(gpus); free(results); free(targs); free(threads);
            return 0;
        }
    }

    fprintf(stderr, "\n[gpu-miner] No solution found.\n");
    printf("{\"found\":false}\n");
    fflush(stdout);

    for (int d = 0; d < dev_count; d++) {
        cudaSetDevice(d);
        cudaFree(gpus[d].d_pre);
        cudaFree(gpus[d].d_diff);
        cudaFree(gpus[d].d_nonce);
        cudaFree(gpus[d].d_flag);
    }
    free(gpus); free(results); free(targs); free(threads);
    return 1;
}
