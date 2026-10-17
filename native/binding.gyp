{
  'targets': [{
    'target_name': 'crw_guard',
    'sources': ['guard.cc'],
    'defines': ['NAPI_VERSION=8'],
    'cflags_cc': ['-std=c++17'],
    'xcode_settings': { 'CLANG_CXX_LANGUAGE_STANDARD': 'c++17' },
    'msvs_settings': { 'VCCLCompilerTool': { 'AdditionalOptions': ['/std:c++17'] } },
    'win_delay_load_hook': 'true'
  }]
}
